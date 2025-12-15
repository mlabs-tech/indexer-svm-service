import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';

export interface IndexerStackProps extends cdk.StackProps {
  stackName?: string;
}

/**
 * Parse a .env file and return key-value pairs
 */
function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  
  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: ${filePath} not found. Using default environment variables.`);
    return env;
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex > 0) {
      const key = trimmed.substring(0, equalIndex).trim();
      let value = trimmed.substring(equalIndex + 1).trim();
      
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      env[key] = value;
    }
  }
  
  return env;
}

export class IndexerStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly repository: ecr.IRepository;

  constructor(scope: Construct, id: string, props?: IndexerStackProps) {
    super(scope, id, props);

    const serviceName = 'cryptarena-indexer';

    // ============================================================================
    // Load environment variables from .env.production file
    // ============================================================================
    const envFilePath = path.join(__dirname, '../.env.production');
    const envVars = parseEnvFile(envFilePath);
    
    console.log('Loaded environment variables:', Object.keys(envVars).join(', '));

    // ============================================================================
    // VPC - Using existing VPC
    // ============================================================================
    this.vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      vpcId: 'vpc-f84cb485',
    });

    // ============================================================================
    // ECR Repository for Docker images
    // Import existing repository (created by deploy script before CDK runs)
    // ============================================================================
    this.repository = ecr.Repository.fromRepositoryName(this, 'IndexerRepository', serviceName);

    // ============================================================================
    // Security Groups
    // ============================================================================
    
    // ALB Security Group - allows HTTP/HTTPS from internet
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${serviceName}-alb-sg`,
      description: 'Security group for ALB',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP from internet'
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from internet'
    );

    // ECS Service Security Group
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${serviceName}-ecs-sg`,
      description: 'Security group for ECS tasks',
      allowAllOutbound: true,
    });
    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3001),
      'Allow traffic from ALB'
    );

    // Redis Security Group
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: `${serviceName}-redis-sg`,
      description: 'Security group for ElastiCache Redis',
      allowAllOutbound: false,
    });
    redisSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(6379),
      'Allow Redis access from ECS tasks'
    );

    // ============================================================================
    // ElastiCache Redis - Minimal configuration for test environment
    // Using cache.t3.micro for cost savings
    // ============================================================================
    
    // Get public subnets from the existing VPC (this VPC only has public subnets)
    const publicSubnets = this.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PUBLIC,
    });

    // Use public subnets for all resources
    const subnetIdsForRedis = publicSubnets.subnetIds;

    // Subnet group for Redis
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      subnetIds: subnetIdsForRedis,
      description: 'Subnet group for Cryptarena Indexer Redis',
      cacheSubnetGroupName: `${serviceName}-redis-subnet`,
    });

    // Redis cluster (single node for test environment)
    const redisCluster = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      clusterName: `${serviceName}-redis`,
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t3.micro', // Smallest/cheapest option
      numCacheNodes: 1, // Single node for test environment
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
      port: 6379,
      // Auto minor version upgrade for security patches
      autoMinorVersionUpgrade: true,
    });
    redisCluster.addDependency(redisSubnetGroup);

    // Construct Redis URL - note: attrRedisEndpointAddress is available at deploy time
    const redisUrl = cdk.Fn.join('', [
      'redis://',
      redisCluster.attrRedisEndpointAddress,
      ':',
      redisCluster.attrRedisEndpointPort,
    ]);

    // ============================================================================
    // ECS Cluster
    // ============================================================================
    this.cluster = new ecs.Cluster(this, 'IndexerCluster', {
      vpc: this.vpc,
      clusterName: serviceName,
      containerInsights: false, // Disable for cost savings in test
    });

    // ============================================================================
    // Task Definition - Resources for test environment
    // ============================================================================
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'IndexerTaskDef', {
      family: serviceName,
      cpu: 512,            // 0.5 vCPU
      memoryLimitMiB: 1024, // 1 GB
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });

    // CloudWatch Logs
    const logGroup = new logs.LogGroup(this, 'IndexerLogGroup', {
      logGroupName: `/ecs/${serviceName}`,
      retention: logs.RetentionDays.ONE_WEEK, // Short retention for test
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ============================================================================
    // Container definition with environment variables from .env.production
    // ============================================================================
    const container = taskDefinition.addContainer('IndexerContainer', {
      containerName: serviceName,
      // Image will be updated by deployment script
      image: ecs.ContainerImage.fromEcrRepository(this.repository, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: serviceName,
        logGroup,
      }),
      portMappings: [
        {
          containerPort: 3001,
          protocol: ecs.Protocol.TCP,
        },
      ],
      environment: {
        // Base configuration
        PORT: '3001',
        HOST: '0.0.0.0',
        LOG_LEVEL: 'info',
        NODE_ENV: 'production',
        // Redis URL from ElastiCache (will be resolved at deploy time)
        REDIS_URL: redisUrl,
        // Environment variables from .env.production file
        ...(envVars.DATABASE_URL && { DATABASE_URL: envVars.DATABASE_URL }),
        ...(envVars.SOLANA_RPC_URL && { SOLANA_RPC_URL: envVars.SOLANA_RPC_URL }),
        ...(envVars.SOLANA_WS_URL && { SOLANA_WS_URL: envVars.SOLANA_WS_URL }),
        ...(envVars.PROGRAM_ID && { PROGRAM_ID: envVars.PROGRAM_ID }),
        ...(envVars.ADMIN_PRIVATE_KEY && { ADMIN_PRIVATE_KEY: envVars.ADMIN_PRIVATE_KEY }),
        ...(envVars.BOT_FUNDER_PRIVATE_KEY && { BOT_FUNDER_PRIVATE_KEY: envVars.BOT_FUNDER_PRIVATE_KEY }),
        ...(envVars.PYTH_HERMES_URL && { PYTH_HERMES_URL: envVars.PYTH_HERMES_URL }),
        ...(envVars.BACKEND_API_URL && { BACKEND_API_URL: envVars.BACKEND_API_URL }),
        ...(envVars.BACKEND_API_KEY && { BACKEND_API_KEY: envVars.BACKEND_API_KEY }),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // ============================================================================
    // Application Load Balancer
    // ============================================================================
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'IndexerAlb', {
      vpc: this.vpc,
      loadBalancerName: `${serviceName}-alb`,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });

    // ============================================================================
    // HTTPS Configuration
    // ============================================================================
    const domainName = 'cryptarena-indexer-test.entertainm.io';
    const hostedZoneName = 'entertainm.io';

    // Wildcard certificate ARN for *.entertainm.io
    const certificateArn = 'arn:aws:acm:us-east-1:498920964263:certificate/07cf5962-cdf0-43d5-b3b0-b761118377eb';

    // Look up the existing hosted zone
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: hostedZoneName,
    });

    // HTTPS Listener (port 443)
    const httpsListener = this.alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [elbv2.ListenerCertificate.fromArn(certificateArn)],
      sslPolicy: elbv2.SslPolicy.TLS12,
    });

    // HTTP Listener - redirect to HTTPS
    const httpListener = this.alb.addListener('HttpListener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // Create Route53 A record pointing to ALB
    new route53.ARecord(this, 'IndexerARecord', {
      zone: hostedZone,
      recordName: 'cryptarena-indexer-test',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(this.alb)
      ),
    });

    // ============================================================================
    // ECS Fargate Service
    // Using deployment configuration for zero-downtime with leader election
    // ============================================================================
    
    // Using public subnets with public IP (this VPC only has public subnets)
    this.service = new ecs.FargateService(this, 'IndexerService', {
      cluster: this.cluster,
      serviceName,
      taskDefinition,
      desiredCount: 1, // Single instance for test (leader election still works)
      securityGroups: [ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true, // Public IP needed for public subnets
      // Deployment configuration for safe rolling updates
      circuitBreaker: {
        rollback: true, // Automatically rollback failed deployments
      },
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      // Minimum and maximum percent during deployment
      // With minHealthyPercent: 100, new task starts BEFORE old one stops
      // This ensures the new task can acquire leader lock before old releases it
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Health check grace period - give time for migrations
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      enableExecuteCommand: true, // Allow exec into containers for debugging
    });

    // Target group with health check (attached to HTTPS listener)
    const targetGroup = httpsListener.addTargets('IndexerTargets', {
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ============================================================================
    // Outputs
    // ============================================================================
    const redisEndpoint = cdk.Fn.join(':', [
      redisCluster.attrRedisEndpointAddress,
      redisCluster.attrRedisEndpointPort,
    ]);

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: this.cluster.clusterArn,
      description: 'ECS Cluster ARN',
    });

    new cdk.CfnOutput(this, 'ServiceArn', {
      value: this.service.serviceArn,
      description: 'ECS Service ARN',
    });

    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR Repository URI',
    });

    new cdk.CfnOutput(this, 'LoadBalancerDns', {
      value: this.alb.loadBalancerDnsName,
      description: 'Application Load Balancer DNS',
    });

    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: redisEndpoint,
      description: 'ElastiCache Redis endpoint',
    });

    new cdk.CfnOutput(this, 'ServiceUrl', {
      value: `https://${domainName}`,
      description: 'Service URL (HTTPS)',
    });

    new cdk.CfnOutput(this, 'DomainName', {
      value: domainName,
      description: 'Custom domain name',
    });

    new cdk.CfnOutput(this, 'EcsSecurityGroupId', {
      value: ecsSecurityGroup.securityGroupId,
      description: 'ECS Security Group ID - Add this to your RDS security group to allow connections',
    });

    new cdk.CfnOutput(this, 'SubnetIds', {
      value: cdk.Fn.join(',', subnetIdsForRedis),
      description: 'Subnet IDs used for the service',
    });
  }
}

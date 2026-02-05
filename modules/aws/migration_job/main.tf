variable "aws_region" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }

# 1. ECR Repository to store the migration image
resource "aws_ecr_repository" "migration_repo" {
  name                 = "mediconnect-migration-job"
  image_tag_mutability = "MUTABLE"
  force_delete         = true # Auto-cleanup
  
  image_scanning_configuration {
    scan_on_push = true # Security Scan
  }
}

# 2. IAM Role for the Migration Task (Least Privilege)
resource "aws_iam_role" "migration_execution_role" {
  name = "mediconnect-migration-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

# Attach the Official AWS Task Execution Policy (For pulling images & logs)
resource "aws_iam_role_policy_attachment" "ecs_execution_standard" {
  role       = aws_iam_role.migration_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Add a separate policy for DynamoDB and SSM (For your application logic)
resource "aws_iam_role_policy" "app_logic_policy" {
  name = "mediconnect-app-logic"
  role = aws_iam_role.migration_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "dynamodb:Scan",
          "dynamodb:GetItem",
          "ssm:GetParameter",
          "kms:Decrypt",
          "logs:CreateLogGroup",  # <--- ADD THIS LINE
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ],
        Resource = "*"
      }
    ]
  })
}

# 3. ECS Cluster (Fargate)
resource "aws_ecs_cluster" "migration_cluster" {
  name = "mediconnect-migration-cluster"
}

# 4. Task Definition (The Job Blueprint)
resource "aws_ecs_task_definition" "migration_task" {
  family                   = "mediconnect-migration-task"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.migration_execution_role.arn
  task_role_arn            = aws_iam_role.migration_execution_role.arn

  container_definitions = jsonencode([{
    name      = "migration-container"
    image     = "${aws_ecr_repository.migration_repo.repository_url}:latest"
    essential = true
    environment = [
      { name = "AWS_REGION", value = var.aws_region }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/mediconnect-migration"
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "migration"
        "awslogs-create-group"  = "true"
      }
    }
  }])
}

# 5. Security Group (Allow Outbound HTTPS only)
resource "aws_security_group" "migration_sg" {
  name        = "mediconnect-migration-sg"
  description = "Allow TLS and Postgres outbound for migration"
  vpc_id      = var.vpc_id

  # Keep the existing 443 rule for Azure/AWS APIs
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # ADD THIS NEW RULE FOR GCP POSTGRES
  egress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- ADD THIS AT THE BOTTOM OF modules/aws/migration_job/main.tf ---

output "migration_repo_url" {
  value       = aws_ecr_repository.migration_repo.repository_url
  description = "The URL of the ECR repository for the migration job"
}

# --- ADD THIS TO THE BOTTOM OF modules/aws/migration_job/main.tf ---

resource "aws_ecr_repository_policy" "migration_repo_policy" {
  repository = aws_ecr_repository.migration_repo.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowECSPull",
        Effect = "Allow",
        Principal = {
          AWS = aws_iam_role.migration_execution_role.arn
        },
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer"
        ]
      }
    ]
  })
}
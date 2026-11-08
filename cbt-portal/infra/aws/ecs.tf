# ============ ECS Fargate: cluster, task definition, service ============
resource "aws_ecr_repository" "svc" {
  for_each             = local.services
  name                 = "${var.project}-${each.key}"
  force_delete         = true
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecs_cluster" "main" {
  name = "${var.project}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each          = merge(local.services, { migrate = {} })
  name              = "/ecs/${var.project}-${each.key}"
  retention_in_days = 14
}

# ---- IAM ----
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "exec" {
  name               = "${var.project}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "exec_secrets" {
  role = aws_iam_role.exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.app.arn] }]
  })
}

# ---- Service discovery: session-service memanggil http://exam.cbt.local:3000 ----
resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${var.project}.local"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "exam" {
  name = "exam"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
}

# ---- Task definitions ----
locals {
  app_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3000" },
    { name = "DB_HOST", value = aws_db_instance.main.address },
    { name = "DB_PORT", value = "3306" },
    { name = "DB_NAME", value = "cbt_portal" },
    { name = "DB_USER", value = "cbt_admin" },
    { name = "DB_POOL", value = "4" },
    { name = "TRUST_PROXY", value = "2" }, # API Gateway -> ALB -> app
    { name = "COOKIE_SECURE", value = "false" },
    { name = "EXAM_SERVICE_URL", value = "http://exam.${var.project}.local:3000" },
  ]
  app_secrets = [
    for k in ["DB_PASSWORD", "SESSION_SECRET", "INTERNAL_TOKEN"] :
    { name = k, valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::" }
  ]
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = local.services
  family                   = "${var.project}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.exec.arn
  container_definitions = jsonencode([{
    name         = each.key
    image        = "${aws_ecr_repository.svc[each.key].repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]
    environment  = each.key == "web" ? [] : concat(local.app_env, [{ name = "SERVICE_NAME", value = each.key }])
    secrets      = each.key == "web" ? [] : local.app_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

# Job sekali jalan: buat tabel + data dummy (dijalankan oleh deploy.sh)
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.project}-migrate"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.exec.arn
  container_definitions = jsonencode([{
    name        = "migrate"
    image       = "${aws_ecr_repository.svc["auth"].repository_url}:${var.image_tag}"
    essential   = true
    command     = ["node", "db/setup.js"]
    environment = local.app_env
    secrets     = local.app_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.svc["migrate"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}

# ---- Services ----
resource "aws_ecs_service" "svc" {
  for_each                           = local.services
  name                               = each.key
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.svc[each.key].arn
  launch_type                        = "FARGATE"
  desired_count                      = var.min_tasks
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 60

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.svc.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.svc[each.key].arn
    container_name   = each.key
    container_port   = each.value.port
  }

  dynamic "service_registries" {
    for_each = each.key == "exam" ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.exam.arn
    }
  }

  # desired_count dikendalikan auto scaling, bukan Terraform
  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.http, aws_lb_listener_rule.api]
}

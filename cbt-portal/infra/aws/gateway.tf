# ============ Load Balancer (ALB internal) + API Gateway (HTTP API) ============
locals {
  services = {
    web     = { port = 80, health = "/healthz", paths = [], priority = 0 }
    auth    = { port = 3000, health = "/health", paths = ["/api/login", "/api/me", "/api/logout"], priority = 10 }
    exam    = { port = 3000, health = "/health", paths = ["/api/exams", "/api/exams/*"], priority = 20 }
    session = { port = 3000, health = "/health", paths = ["/api/sessions", "/api/sessions/*"], priority = 30 }
  }
  api_services = { for k, v in local.services : k => v if k != "web" }
}

resource "aws_lb" "main" {
  name               = "${var.project}-alb"
  internal           = true # tidak terbuka ke internet; satu-satunya pintu masuk = API Gateway
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.private[*].id
  idle_timeout       = 60
}

resource "aws_lb_target_group" "svc" {
  for_each             = local.services
  name                 = "${var.project}-${each.key}"
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30
  health_check {
    path                = each.value.health
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action { # semua yang bukan /api/* -> frontend statis
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["web"].arn
  }
}

resource "aws_lb_listener_rule" "api" {
  for_each     = local.api_services
  listener_arn = aws_lb_listener.http.arn
  priority     = each.value.priority
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc[each.key].arn
  }
  condition {
    path_pattern { values = each.value.paths }
  }
}

# Blokir /internal/* di level ALB (defense in depth)
resource "aws_lb_listener_rule" "block_internal" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 1
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "not found"
    }
  }
  condition {
    path_pattern { values = ["/internal/*"] }
  }
}

# ---------------- API Gateway (HTTP API) -> VPC Link -> ALB ----------------
resource "aws_apigatewayv2_api" "http" {
  name          = "${var.project}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = "${var.project}-vpclink"
  security_group_ids = [aws_security_group.vpclink.id]
  subnet_ids         = aws_subnet.private[*].id
}

resource "aws_apigatewayv2_integration" "alb" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  integration_uri        = aws_lb_listener.http.arn
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.main.id
  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_rate_limit  = var.api_throttle_rate
    throttling_burst_limit = var.api_throttle_burst
  }
}

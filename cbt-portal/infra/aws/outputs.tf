output "app_url" {
  description = "URL publik aplikasi (API Gateway)"
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "alb_dns_internal" {
  value = aws_lb.main.dns_name
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.svc : k => r.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "migrate_task_definition" {
  value = aws_ecs_task_definition.migrate.family
}

output "private_subnet_ids" {
  value = join(",", aws_subnet.private[*].id)
}

output "service_security_group_id" {
  value = aws_security_group.svc.id
}

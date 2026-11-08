# ============ Auto Scaling (Application Auto Scaling, target tracking) ============
resource "aws_appautoscaling_target" "svc" {
  for_each           = local.services
  min_capacity       = var.min_tasks
  max_capacity       = var.max_tasks
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.svc[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

# Scale out jika rata-rata CPU > target; scale in pelan-pelan (cooldown lebih lama).
resource "aws_appautoscaling_policy" "cpu" {
  for_each           = local.services
  name               = "${var.project}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target
    scale_out_cooldown = 60
    scale_in_cooldown  = 180
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "memory" {
  for_each           = local.services
  name               = "${var.project}-${each.key}-memory"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = 75
    scale_out_cooldown = 60
    scale_in_cooldown  = 180
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
  }
}

# Scaling berbasis beban nyata: jumlah request per task dari ALB (service API saja).
resource "aws_appautoscaling_policy" "requests" {
  for_each           = local.api_services
  name               = "${var.project}-${each.key}-requests"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace
  target_tracking_scaling_policy_configuration {
    target_value       = var.requests_per_target
    scale_out_cooldown = 60
    scale_in_cooldown  = 180
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.svc[each.key].arn_suffix}"
    }
  }
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "mysql" {
  name_prefix = "${var.project}-mysql8-"
  family      = "mysql8.0"
  parameter {
    name  = "max_connections"
    value = "150"
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_db_instance" "main" {
  identifier              = "${var.project}-mysql"
  engine                  = "mysql"
  engine_version          = "8.0"
  instance_class          = var.db_instance_class
  allocated_storage       = 20
  storage_type            = "gp3"
  storage_encrypted       = true
  db_name                 = "cbt_portal"
  username                = "cbt_admin"
  password                = var.db_password
  db_subnet_group_name    = aws_db_subnet_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  parameter_group_name    = aws_db_parameter_group.mysql.name
  multi_az                = var.db_multi_az
  publicly_accessible     = false
  backup_retention_period = 7
  skip_final_snapshot     = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.project}-final"
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.project}/app"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DB_PASSWORD    = var.db_password
    SESSION_SECRET = var.session_secret
    INTERNAL_TOKEN = var.internal_token
  })
}

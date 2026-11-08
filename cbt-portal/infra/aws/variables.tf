variable "region" {
  type    = string
  default = "ap-southeast-1"
}

variable "project" {
  type    = string
  default = "cbt"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

# ---- Secrets (isi lewat terraform.tfvars / TF_VAR_*; jangan di-commit) ----
variable "db_password" {
  type      = string
  sensitive = true
  validation {
    condition     = length(var.db_password) >= 8 && !can(regex("[/@\" ]", var.db_password))
    error_message = "Minimal 8 karakter, tanpa spasi, / @ atau tanda kutip (aturan RDS)."
  }
}

variable "session_secret" {
  type      = string
  sensitive = true
}

variable "internal_token" {
  type      = string
  sensitive = true
}

# ---- Database ----
variable "db_instance_class" {
  type    = string
  default = "db.t3.small"
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "skip_final_snapshot" {
  type    = bool
  default = true
}

# ---- Auto scaling ----
variable "min_tasks" {
  description = "Jumlah task minimum per service (>=2 agar tetap tersedia di 2 AZ)"
  type        = number
  default     = 2
}

variable "max_tasks" {
  description = "Jumlah task maksimum per service. Perhatikan: 3 service x max_tasks x DB_POOL(4) harus < max_connections RDS (150)."
  type        = number
  default     = 6
}

variable "cpu_target" {
  type    = number
  default = 60
}

variable "requests_per_target" {
  description = "Target request per menit per task untuk scaling berbasis ALB request count"
  type        = number
  default     = 3000
}

variable "api_throttle_rate" {
  description = "Batas request/detik di API Gateway"
  type        = number
  default     = 200
}

variable "api_throttle_burst" {
  type    = number
  default = 400
}

#!/usr/bin/env bash
# Deploy end-to-end ke AWS: ECR -> build & push image -> infrastruktur -> migrasi DB.
# Prasyarat: aws cli (sudah `aws configure`), terraform, docker, file terraform.tfvars.
set -euo pipefail
cd "$(dirname "$0")"

REGION="${AWS_REGION:-ap-southeast-1}"
TAG="${IMAGE_TAG:-latest}"
ROOT="../.."

terraform init -input=false

echo "==> 1/5 Membuat repository ECR"
terraform apply -input=false -auto-approve -target=aws_ecr_repository.svc

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REG="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REG"

echo "==> 2/5 Build & push image (linux/amd64 untuk Fargate)"
for s in auth exam session; do
  docker build --platform linux/amd64 --build-arg SERVICE="$s" -t "$REG/cbt-$s:$TAG" "$ROOT"
  docker push "$REG/cbt-$s:$TAG"
done
docker build --platform linux/amd64 -f "$ROOT/gateway/Dockerfile" --build-arg MODE=static -t "$REG/cbt-web:$TAG" "$ROOT"
docker push "$REG/cbt-web:$TAG"

echo "==> 3/5 Membuat VPC, RDS, ALB, API Gateway, ECS, Auto Scaling"
terraform apply -input=false -auto-approve -var "image_tag=$TAG"

echo "==> 4/5 Migrasi database (buat tabel + data dummy)"
CLUSTER="$(terraform output -raw ecs_cluster)"
TASK_ARN="$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition "$(terraform output -raw migrate_task_definition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -raw private_subnet_ids)],securityGroups=[$(terraform output -raw service_security_group_id)],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)"
aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN"
EXIT="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text)"
[ "$EXIT" = "0" ] || { echo "Migrasi gagal (exit $EXIT). Lihat log CloudWatch /ecs/cbt-migrate"; exit 1; }

echo "==> 5/5 Selesai. Buka: $(terraform output -raw app_url)"

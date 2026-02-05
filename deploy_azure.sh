#!/bin/bash
# Deploy Doctor Service to Azure Container Apps

# Config
RG="mediconnect-rg"
ACR="zahidmediconnectacr"
ENV="mediconnect-env"
IMAGE="$ACR.azurecr.io/doctor-service"
LOCATION="eastus"

echo "Deploying to Azure Container Apps..."

# Login & Build
az acr login --name $ACR
docker build -t $IMAGE -f backend_v2/doctor-service/Dockerfile backend_v2
docker push $IMAGE

# Deploy
az containerapp create \
  --name doctor-service \
  --resource-group $RG \
  --environment $ENV \
  --image $IMAGE \
  --target-port 8082 \
  --ingress 'external' \
  --min-replicas 0 \
  --max-replicas 10 \
  --env-vars "NODE_ENV=production" "AWS_REGION=us-east-1" "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY"

echo "Deployment Complete."
az containerapp show --name doctor-service --resource-group $RG --query properties.configuration.ingress.fqdn

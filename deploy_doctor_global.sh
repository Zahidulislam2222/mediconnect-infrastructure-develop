#!/bin/bash
set -e

# Configuration
RG="mediconnect-rg"
ACR="zahidmediconnectacr"
APP_NAME="doctor-service"
IMAGE_TAG="v-$(date +%Y%m%d-%H%M%S)"
FULL_IMAGE="$ACR.azurecr.io/$APP_NAME:$IMAGE_TAG"

echo "🚀 STARTING DEPLOYMENT: DOCTOR SERVICE"

# 1. Build Docker Image (Root Context)
echo "🔨 Building Docker Image..."
# Run from backend_v2 root
docker build -t $FULL_IMAGE -f doctor-service/Dockerfile .

# 2. Push to Azure
echo "☁️  Pushing to Azure ACR..."
az acr login --name $ACR
docker push $FULL_IMAGE

# 3. Update Container App
echo "🚀 Updating Container App..."
az containerapp update \
  --name $APP_NAME \
  --resource-group $RG \
  --image $FULL_IMAGE \
  --set-env-vars NODE_ENV=production

echo "✅ DOCTOR SERVICE DEPLOYED!"
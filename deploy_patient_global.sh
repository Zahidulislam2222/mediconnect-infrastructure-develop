#!/bin/bash
set -e

# Configuration
PROJECT_ID="mediconnect-analytics"
SERVICE_NAME="patient-service"
IMAGE_NAME="gcr.io/$PROJECT_ID/$SERVICE_NAME"
TAG="v-$(date +%Y%m%d-%H%M%S)"

echo "🚀 STARTING GLOBAL DEPLOYMENT: PATIENT SERVICE"

# 1. Build the Docker Image (Multi-Stage handles the 'shared' folder)
echo "🔨 Building Docker Image..."
# Run from backend_v2 root so it sees 'shared' folder
docker build -t "$IMAGE_NAME:$TAG" -f patient-service/Dockerfile .

# 2. Push Image to Container Registry
echo "☁️  Pushing Image to GCR..."
docker push "$IMAGE_NAME:$TAG"

# 3. Deploy to US Region (Iowa)
echo "🇺🇸 Deploying to US-CENTRAL1..."
gcloud run deploy "$SERVICE_NAME-us" \
  --image "$IMAGE_NAME:$TAG" \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,AWS_REGION=us-east-1

# 4. Deploy to EU Region (Frankfurt)
echo "🇪🇺 Deploying to EUROPE-WEST3..."
gcloud run deploy "$SERVICE_NAME-eu" \
  --image "$IMAGE_NAME:$TAG" \
  --region europe-west3 \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,AWS_REGION=eu-central-1

echo "✅ GLOBAL DEPLOYMENT COMPLETE!"
#!/bin/bash
# Deploy Patient Service to Google Cloud Run

# Config
PROJECT_ID=$GCP_PROJECT_ID
REGION="us-central1"
IMAGE="gcr.io/$PROJECT_ID/patient-service"
SERVICE_NAME="patient-service"

echo "Deploying to Google Cloud Run..."

# Build (Assumes running from project root)
docker build -t $IMAGE -f backend_v2/patient-service/Dockerfile backend_v2

# Push
docker push $IMAGE

# Deploy
gcloud run deploy $SERVICE_NAME \
  --image $IMAGE \
  --project $PROJECT_ID \
  --region $REGION \
  --platform managed \
  --allow-unauthenticated \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 10 \
  --port 8081 \
  --env-vars "NODE_ENV=production" "AWS_REGION=us-east-1" "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY"

echo "Deployment Complete. URL:"
gcloud run services describe $SERVICE_NAME --platform managed --region $REGION --format 'value(status.url)'

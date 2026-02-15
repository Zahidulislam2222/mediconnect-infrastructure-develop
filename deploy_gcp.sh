#!/bin/bash
# MediConnect Enterprise GCP Professional Deploy
# Optimization: Host Compilation + Safe Upload (Fixes Missing Module)
set -e

# 1. Configuration
PROJECT_ID="mediconnect-analytics"
REGION="us-central1"
REPO_NAME="mediconnect-repo"
SERVICE_NAME="patient-service"
IMAGE_BASE="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/$SERVICE_NAME"
TAG="v-$(date +%Y%m%d-%H%M%S)"
IMAGE_WITH_TAG="$IMAGE_BASE:$TAG"
IMAGE_LATEST="$IMAGE_BASE:latest"

echo "🔹 Starting Professional Build for $SERVICE_NAME ($TAG)..."

# 2. HOST COMPILATION
echo "⚙️  Compiling TypeScript locally (Host)..."

# Navigate to service
cd backend_v2/patient-service

# Install Dev Deps & Build
npm install
npm run build

echo "✅ Compilation Complete. 'dist' folder ready."
cd ../.. # Go back to root

# 3. PREPARE SAFE UPLOAD
# 🟢 FIX: Simplified ignore rules. We DO NOT ignore 'src' anymore.
# This prevents accidentally deleting the compiled code inside dist.
echo "📄 Generating .gcloudignore to optimize upload..."
cat > backend_v2/.gcloudignore <<EOF
# Only ignore the massive node_modules folder
**/node_modules
.git
.env
cloud-sql-proxy.exe
debug.log
*.md

# Explicitly Allow the dist folder
!patient-service/dist
!patient-service/package.json
!patient-service/package-lock.json
!patient-service/Dockerfile
EOF

# 4. Prepare Dockerfile for Context
cp backend_v2/patient-service/Dockerfile backend_v2/Dockerfile

# 5. REMOTE CLOUD BUILD
echo "☁️  Submitting build to Google Cloud..."
gcloud builds submit backend_v2 --tag $IMAGE_WITH_TAG --project $PROJECT_ID

# 6. Registry Management
gcloud artifacts docker tags add $IMAGE_WITH_TAG $IMAGE_LATEST --quiet

# 7. Deploy to Cloud Run
echo "🚀 Updating Cloud Run service..."
gcloud run deploy $SERVICE_NAME \
  --image $IMAGE_WITH_TAG \
  --project $PROJECT_ID \
  --region $REGION \
  --port 8081 \
  --platform managed \
  --allow-unauthenticated

# Cleanup
rm backend_v2/Dockerfile
rm backend_v2/.gcloudignore

echo "🎯 Professional Deployment Complete."
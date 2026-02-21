#!/bin/bash
# MediConnect Enterprise GCP Professional Deploy
# Multi-Region Support for GDPR (US & EU)
set -e

# 1. 🟢 MULTI-REGION ROUTER
TARGET=$1

# 🟢 FIX: Correct Bash Syntax for IF statements
if [[ "$TARGET" == "eu" ]]; then
    echo "🌍 Target: EUROPE (Frankfurt)"
    REGION="europe-west3"
    SERVICE_NAME="doctor-service-eu" # Corrected to doctor-service based on context
elif [[ "$TARGET" == "us" ]]; then
    echo "🌎 Target: UNITED STATES (Iowa)"
    REGION="us-central1"
    SERVICE_NAME="doctor-service-us" # Corrected to doctor-service based on context
else
    echo "❌ ERROR: You must specify a region! Usage: ./deploy_gcp.sh us OR ./deploy_gcp.sh eu"
    exit 1
fi

PROJECT_ID="mediconnect-analytics"
REPO_NAME="mediconnect-repo"
# Note: GCP Artifact Registry can be global or regional. Assuming you use the US one to store images to save setup time.
IMAGE_BASE="us-central1-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/$SERVICE_NAME"
TAG="v-$(date +%Y%m%d-%H%M%S)"
IMAGE_WITH_TAG="$IMAGE_BASE:$TAG"

echo "🔹 Starting Professional Build for $SERVICE_NAME ($TAG)..."

# 2. HOST COMPILATION
echo "⚙️  Compiling TypeScript locally (Host)..."
cd backend_v2/patient-service
npm install
npm run build
echo "✅ Compilation Complete. 'dist' folder ready."
cd ../.. 

# 3. PREPARE SAFE UPLOAD
echo "📄 Generating .gcloudignore to optimize upload..."
cat > backend_v2/.gcloudignore <<EOF
**/node_modules
.git
.env
cloud-sql-proxy.exe
debug.log
*.md
!patient-service/dist
!patient-service/package.json
!patient-service/package-lock.json
!patient-service/Dockerfile
!shared
EOF

cp backend_v2/patient-service/Dockerfile backend_v2/Dockerfile

# 4. REMOTE CLOUD BUILD
echo "☁️  Submitting build to Google Cloud..."
gcloud builds submit backend_v2 --tag $IMAGE_WITH_TAG --project $PROJECT_ID

# 5. DEPLOY TO CLOUD RUN (IN SPECIFIC REGION)
echo "🚀 Updating Cloud Run service in $REGION..."
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

echo "🎯 Professional Deployment to $REGION Complete."
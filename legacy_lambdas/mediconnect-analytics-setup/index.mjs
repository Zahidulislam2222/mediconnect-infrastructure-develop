import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import https from "https";
import crypto from "crypto";

const secrets = new SecretsManagerClient({});

// --- HELPER: Sign Google JWT (Replaces Google Library) ---
function createJWT(email, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: email,
    scope: "https://www.googleapis.com/auth/bigquery",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedClaim = Buffer.from(JSON.stringify(claim)).toString('base64url');
  
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${encodedHeader}.${encodedClaim}`);
  const signature = signer.sign(privateKey, 'base64url');
  
  return `${encodedHeader}.${encodedClaim}.${signature}`;
}

// --- HELPER: Get Access Token ---
async function getAccessToken(email, privateKey) {
  const jwt = createJWT(email, privateKey);
  const postData = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;
  
  return new Promise((resolve, reject) => {
    const req = https.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(JSON.parse(data).access_token));
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// --- HELPER: Send Data to BigQuery ---
async function insertRows(projectId, dataset, table, rows, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(`https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${dataset}/tables/${table}/insertAll`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(JSON.stringify({ rows: rows.map(r => ({ json: r })) }));
    req.end();
  });
}

export const handler = async (event) => {
  try {
    console.log("Reading Secrets...");
    const secretData = await secrets.send(new GetSecretValueCommand({ SecretId: "mediconnect/gcp/bigquery_key" }));
    const creds = JSON.parse(secretData.SecretString);

    console.log("Authenticating with Google (Zero-Dep)...");
    const token = await getAccessToken(creds.client_email, creds.private_key);
    
    // Define Data
    const row = {
        consultation_id: "REAL-DIRECT-" + Date.now(),
        patient_id: "patient-101",
        doctor_id: "doc-55",
        duration_minutes: 30,
        sentiment_score: 0.99,
        timestamp: new Date().toISOString()
    };

    console.log("Inserting Data into BigQuery...");
    const response = await insertRows(creds.project_id, "mediconnect_analytics", "analytics_consultations", [row], token);

    if (response.insertErrors) {
        throw new Error("BigQuery Insert Error: " + JSON.stringify(response.insertErrors));
    }

    return { statusCode: 200, body: "SUCCESS: Real Data written via Direct API." };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: err.message };
  }
};

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// 🔒 HEADERS (The Fix)
const HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST"
};

export const handler = async (event) => {
  // 🟢 1. Handle Pre-flight (CORS)
  if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: HEADERS, body: '' };
  }

  try {
    const body = JSON.parse(event.body || "{}"); // Safety check for empty body
    const { patientId, modelType, vitals, history } = body;
    
    let result = {};
    let confidence = 0;

    // --- MODEL 1: Sepsis Early Detection (Rule-Based Simulation) ---
    if (modelType === "SEPSIS") {
        // Clinical Rule: Fever + High Heart Rate + Low BP = Danger
        const isFever = vitals.temp > 101;
        const isTachycardia = vitals.heartRate > 90;
        const isHypotension = vitals.bpSys < 100;
        
        if (isFever && isTachycardia && isHypotension) {
            result = { risk: "CRITICAL", message: "Sepsis protocol initiated. Immediate intervention required." };
            confidence = 0.98;
        } else if (isFever || isTachycardia) {
            result = { risk: "MODERATE", message: "Monitor closely for signs of infection." };
            confidence = 0.75;
        } else {
            result = { risk: "LOW", message: "Vitals stable." };
            confidence = 0.99;
        }
    }

    // --- MODEL 2: Readmission Risk Scoring ---
    else if (modelType === "READMISSION") {
        // Logic: Older age + recent visits = High Risk
        const riskScore = (vitals.age * 0.5) + (history.recentVisits * 10);
        if (riskScore > 60) {
            result = { risk: "HIGH", score: riskScore, message: "Schedule follow-up within 48 hours." };
            confidence = 0.85;
        } else {
            result = { risk: "LOW", score: riskScore, message: "Standard discharge protocol." };
            confidence = 0.90;
        }
    }

    // --- MODEL 3: No-Show Prediction ---
    else if (modelType === "NO_SHOW") {
        if (history.missedAppointments > 2) {
             result = { likelihood: "HIGH", message: "Send SMS and Call reminder." };
             confidence = 0.88;
        } else {
             result = { likelihood: "LOW", message: "Standard SMS reminder." };
             confidence = 0.92;
        }
    } 
    
    else {
        return { 
            statusCode: 400, 
            headers: HEADERS, 
            body: JSON.stringify({ error: "Unknown Model Type" }) 
        };
    }

    const predictionId = "PRED-" + Date.now();
    const predictionRecord = {
        predictionId,
        patientId,
        modelType,
        input: vitals,
        output: result,
        confidence,
        timestamp: new Date().toISOString()
    };

    // Store Prediction in DynamoDB
    await ddb.send(new PutCommand({
        TableName: "mediconnect-predictions",
        Item: predictionRecord
    }));

    return { 
        statusCode: 200, 
        headers: HEADERS, // ✅ Headers added here
        body: JSON.stringify(predictionRecord) 
    };

  } catch (err) {
    console.error(err);
    return { 
        statusCode: 500, 
        headers: HEADERS, 
        body: JSON.stringify({ error: err.message }) 
    };
  }
};
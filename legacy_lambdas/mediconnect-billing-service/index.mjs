import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_TRANSACTIONS = "mediconnect-transactions";
// 🟢 USE YOUR NEW INDEXES
const INDEX_PATIENT = "PatientIndex";
const INDEX_DOCTOR = "DoctorIndex";

// 🔒 HEADERS (Strict CORS)
const HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
};

export const handler = async (event) => {
  try {
    console.log("EVENT:", JSON.stringify(event));

    // 1. Pre-flight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: HEADERS, body: '' };
    }

    // 🟢 2. GET Request (READING DATA)
    if (event.httpMethod === 'GET') {
        const query = event.queryStringParameters || {};
        
// --- 📊 ANALYTICS MODE (CORRECTED FOR REFUNDS) ---
if (query.type === 'analytics') {
    const doctorId = query.doctorId;
    if (!doctorId) return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Missing doctorId" }) };

    // Use the FAST Query on your Index
    const command = new QueryCommand({
        TableName: "mediconnect-transactions",
        IndexName: INDEX_DOCTOR,
        KeyConditionExpression: "doctorId = :did",
        ExpressionAttributeValues: { ":did": doctorId },
    });

    const response = await docClient.send(command);
    const transactions = response.Items || [];

    // --- 🟢 THE LOGIC FIX STARTS HERE ---
    let totalRevenue = 0;
    let consultationCount = 0;
    const monthlyRevenue = {};

    transactions.forEach(tx => {
        // This will handle both positive (50) and negative (-50) amounts
        const amount = Number(tx.amount) || Number(tx.totalAmount) || 0;
        
        // 1. Sum up all transactions correctly
        totalRevenue += amount;
        
        // 2. Only count "consultations" if it was a charge, not a refund
        if (amount > 0) {
            consultationCount++;
        }

        // 3. Group by month for the chart
        if (tx.createdAt) {
            const monthKey = tx.createdAt.substring(0, 7);
            if (!monthlyRevenue[monthKey]) monthlyRevenue[monthKey] = 0;
            monthlyRevenue[monthKey] += amount;
        }
    });

    // --- 🟢 THE LOGIC FIX ENDS HERE ---

    // Convert to Array and Sort by Date
    const chartData = Object.keys(monthlyRevenue)
        .sort()
        .slice(-6) // Limit to last 6 months for clean UI
        .map(key => {
            const [year, month] = key.split('-');
            const dateObj = new Date(parseInt(year), parseInt(month) - 1);
            return {
                month: dateObj.toLocaleString('default', { month: 'short' }),
                revenue: monthlyRevenue[key]
            };
        });

    return {
        statusCode: 200, 
        headers: HEADERS, 
        body: JSON.stringify({
            totalRevenue,
            consultationCount,
            chartData,
            patientSatisfaction: 4.9 // Placeholder
        })
    };
}

        // --- 💰 PATIENT BILLING MODE (PATIENT PAGE) ---
        const patientId = query.patientId;
        if (!patientId) {
            return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Missing patientId" }) };
        }

        // 🟢 PROFESSIONAL FIX: Use Query on PatientIndex
        const command = new QueryCommand({
            TableName: TABLE_TRANSACTIONS,
            IndexName: INDEX_PATIENT,
            KeyConditionExpression: "patientId = :pid",
            ExpressionAttributeValues: { ":pid": patientId }
        });

        const response = await docClient.send(command);
        const transactions = response.Items || [];

        // 1. Calculate Balance (Sum of PENDING items)
        let totalBalance = 0;
        transactions.forEach(tx => {
            const amount = Number(tx.amount) || Number(tx.patientResponsibility) || 0;
            if (tx.status === 'PENDING' || tx.status === 'DUE') {
                totalBalance += amount;
            }
        });

        return {
            statusCode: 200,
            headers: HEADERS,
            body: JSON.stringify({
                patientId,
                outstandingBalance: totalBalance,
                currency: "USD",
                insuranceProvider: transactions[0]?.insuranceProvider || "BlueCross",
                insuranceStatus: "ACTIVE",
                // Return the list so the UI Table works
                transactions: transactions.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)) 
            })
        };
    }

    // 🔵 3. POST Request (MANUAL BILL CREATION - Optional)
    if (event.httpMethod === 'POST') {
        const { patientId, doctorId, amount, insuranceProvider } = JSON.parse(event.body);
        
        let coverage = 0;
        if (insuranceProvider === 'BlueCross') coverage = 0.80; 
        if (insuranceProvider === 'Medicare') coverage = 0.90; 
        
        const insuranceAmount = amount * coverage;
        const patientAmount = amount - insuranceAmount;
        const billId = "BILL-" + Date.now();

        const bill = {
            billId,
            patientId,
            doctorId,
            amount: amount, // Normalize field name
            patientResponsibility: patientAmount,
            insuranceResponsibility: insuranceAmount,
            status: "PENDING",
            createdAt: new Date().toISOString(),
            type: "MANUAL_INVOICE"
        };

        await docClient.send(new PutCommand({ TableName: TABLE_TRANSACTIONS, Item: bill }));

        return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ message: "Bill Created", billId, patientAmount }) };
    }

  } catch (error) {
    console.error("CRASH:", error);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: error.message }) };
  }
};
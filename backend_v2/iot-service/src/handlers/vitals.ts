import { docClient } from "../config/aws";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_VITALS = "mediconnect-iot-vitals";

export const vitalsHandler = async (queryParams: any) => {
    const { patientId, limit = 20 } = queryParams;

    if (!patientId) throw new Error("patientId required");

    const response = await docClient.send(new QueryCommand({
        TableName: TABLE_VITALS,
        KeyConditionExpression: "patientId = :pid",
        ExpressionAttributeValues: { ":pid": patientId },
        ScanIndexForward: false, // Newest first
        Limit: Number(limit)
    }));

    return response.Items || [];
};

/**
 * Deterministic Conversation ID Generator
 * 
 * Logic:
 * 1. Takes two User IDs (e.g., DoctorID and PatientID).
 * 2. Sorts them alphabetically.
 * 3. Joins them with a standard separator.
 * 
 * Result: 
 * - generate("doc1", "pat1") -> "CONV#doc1#pat1"
 * - generate("pat1", "doc1") -> "CONV#doc1#pat1"
 * 
 * @param userA - First User ID
 * @param userB - Second User ID
 * @returns A unique, permanent string key for the DynamoDB Partition Key.
 */
export const generateConversationId = (userA: string, userB: string): string => {
    if (!userA || !userB) {
        throw new Error("Cannot generate Conversation ID: Missing user IDs");
    }
    const [first, second] = [userA, userB].sort();
    return `CONV#${first}#${second}`;
};
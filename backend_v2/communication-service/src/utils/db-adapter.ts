import { CosmosClient } from "@azure/cosmos";
import { Firestore } from "@google-cloud/firestore";
import { getSSMParameter } from "../config/aws";

// 🟢 Unified Interface: Controllers don't need to know which DB they are using
export interface IDatabase {
    save(collection: string, data: any): Promise<void>;
}

// --- ADAPTER 1: AZURE COSMOS DB (US) ---
class AzureAdapter implements IDatabase {
    private client: CosmosClient | null = null;

    async connect() {
        if (this.client) return;
        const endpoint = await getSSMParameter("/mediconnect/prod/azure/cosmos/endpoint", "us-east-1");
        const key = await getSSMParameter("/mediconnect/prod/azure/cosmos/primary_key", "us-east-1", true);
        if (!endpoint || !key) throw new Error("Azure Cosmos Config Missing");
        this.client = new CosmosClient({ endpoint, key });
    }

    async save(collection: string, data: any): Promise<void> {
        await this.connect();
        const container = this.client!.database("mediconnect-db").container(collection);
        await container.items.create(data);
    }
}

// --- ADAPTER 2: GOOGLE FIRESTORE (EU) ---
class GoogleAdapter implements IDatabase {
    private firestore: Firestore;

    constructor() {
        // GCP automatically picks up credentials from the Cloud Run environment
        this.firestore = new Firestore({ 
            projectId: 'mediconnect-analytics', // Your GCP Project ID
            databaseId: '(default)' 
        });
    }

    async save(collection: string, data: any): Promise<void> {
        // Firestore uses 'collections' just like Cosmos uses 'containers'
        // We use the ID as the document key if present, else auto-gen
        const docRef = data.id 
            ? this.firestore.collection(collection).doc(data.id) 
            : this.firestore.collection(collection).doc();
        
        await docRef.set(data);
    }
}

// 🟢 FACTORY: Pick the right free database based on Region
export const getRegionalDB = (region: string): IDatabase => {
    const isEU = region.toUpperCase() === 'EU' || region === 'eu-central-1';
    
    if (isEU) {
        console.log(`🇪🇺 [EU] Using Google Firestore (Frankfurt)`);
        return new GoogleAdapter();
    } else {
        console.log(`🇺🇸 [US] Using Azure Cosmos DB (Virginia)`);
        return new AzureAdapter();
    }
};
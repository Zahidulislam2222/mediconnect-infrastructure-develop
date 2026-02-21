import { Router } from 'express';
import { getRegionalClient } from '../config/aws'; 
import { ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
    createPatient,
    getDemographics,
    getProfile,
    updateProfile,
    verifyIdentity,
    deleteProfile,
    getPatientById,
    searchPatients
} from '../controllers/patient.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { writeAuditLog } from '../../../shared/audit';

// ==========================================
// 🛡️ PUBLIC HANDLERS
// ==========================================

export const getPublicKnowledge = async (req: any, res: any) => {
    try {
        const tableName = "mediconnect-knowledge-base";
        const userRegion = req.headers['x-user-region'] || "us-east-1"; // 🟢 Detect Region
        const dynamicDb = getRegionalClient(userRegion); // 🟢 Use Local DB
        
        const params = { TableName: tableName };
        const { Items } = await dynamicDb.send(new ScanCommand(params));
        
        if (!Items || Items.length === 0) return res.json([]);

        // 🟢 FIX: DocumentClient auto-unmarshalls, so we don't need 'unmarshall(item)'
        const fhirArticles = Items.map((art: any) => {
            return {
                id: art.topic || art.id,
                resourceType: "DocumentReference",
                description: art.title || "Untitled",
                content: [{ attachment: { url: art.coverImage } }],
                legacyData: { category: art.category || "General", content: art.content }
            };
        });
        res.json(fhirArticles);
    } catch (error: any) {
        console.error("DYNAMO_ERROR:", error.message);
        res.status(500).json({ error: error.message });
    }
};

export const getPublicArticle = async (req: any, res: any) => {
    try {
        const { id } = req.params;
        const userRegion = req.headers['x-user-region'] || "us-east-1"; // 🟢 Detect Region
        const dynamicDb = getRegionalClient(userRegion); // 🟢 Use Local DB

        const params = { TableName: "mediconnect-knowledge-base", Key: { topic: id } }; // 🟢 Simplified Key for DocumentClient
        
        const { Item: art } = await dynamicDb.send(new GetCommand(params));
        
        if (!art) return res.status(404).json({ error: "Article not found" });

        const fhirArticle = {
            id: art.topic,
            resourceType: "DocumentReference",
            date: art.publishedAt,
            description: art.title,
            content: [{ attachment: { url: art.coverImage, title: art.title } }],
            legacyData: { category: art.category, content: art.content, slug: art.slug }
        };

        const userId = (req as any).user?.id || "GUEST";
        await writeAuditLog(userId, "PUBLIC", "READ_KB_ITEM", `Read article: ${art.title}`, { articleId: id, region: userRegion });
        
        res.json(fhirArticle);
    } catch (error) {
        console.error("Article Error:", error);
        res.status(500).json({ error: "Content currently unavailable" });
    }
};

const router = Router();

// ==========================================
// 1️⃣ PUBLIC ROUTES (Specific First)
// ==========================================
router.get('/public/knowledge', getPublicKnowledge);
router.get('/public/knowledge/:id', getPublicArticle);
router.get('/stats/demographics', getDemographics);
router.post('/register-patient', createPatient); // POST is public
router.post('/', createPatient);

// ==========================================
// 2️⃣ PASS-THROUGH (For IoT Router)
// ==========================================
// 🟢 MUST be before 'authMiddleware' and before '/:id'
router.get(['/vitals', '/emergency', '/vitals/*', '/emergency/*'], (req, res, next) => {
    next('router');
});

// ==========================================
// 🔒 PROTECTED BOUNDARY
// ==========================================
router.use(authMiddleware);

// ==========================================
// 3️⃣ PROTECTED SPECIFIC ROUTES
// ==========================================
router.get('/search', searchPatients); 
router.get('/register-patient', getPatientById); 
router.post('/identity/verify', verifyIdentity);
router.get('/:userId', getPatientById);
router.delete('/me', deleteProfile);

// ==========================================
// 4️⃣ PROTECTED GENERIC / CATCH-ALL
// ==========================================
router.get(['/patients/:id', '/:id'], getProfile);
router.put(['/patients/:id', '/:id'], updateProfile);

export default router;
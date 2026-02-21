import { Router, Request, Response } from 'express';
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
    searchPatients,
    extractRegion // Imported from the controller fix
} from '../controllers/patient.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { writeAuditLog } from '../../../shared/audit';

const router = Router();

// ==========================================
// 📖 1. PUBLIC ROUTES (No Token Required)
// ==========================================

export const getPublicKnowledge = async (req: Request, res: Response) => {
    try {
        const userRegion = extractRegion(req);
        const dynamicDb = getRegionalClient(userRegion);
        
        const { Items } = await dynamicDb.send(new ScanCommand({ TableName: "mediconnect-knowledge-base" }));
        if (!Items || Items.length === 0) return res.json([]);

        // 🟢 FHIR: Map public articles to DocumentReference
        const fhirArticles = Items.map((art: any) => ({
            id: art.topic || art.id,
            resourceType: "DocumentReference",
            description: art.title || "Untitled",
            content: [{ attachment: { url: art.coverImage } }],
            legacyData: { category: art.category || "General", content: art.content }
        }));
        res.json(fhirArticles);
    } catch (error: any) {
        res.status(500).json({ error: "Knowledge Base Unavailable" });
    }
};

export const getPublicArticle = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const userRegion = extractRegion(req);
        const dynamicDb = getRegionalClient(userRegion);

        const { Item: art } = await dynamicDb.send(new GetCommand({ 
            TableName: "mediconnect-knowledge-base", 
            Key: { topic: id } 
        }));
        
        if (!art) return res.status(404).json({ error: "Article not found" });

        const fhirArticle = {
            id: art.topic,
            resourceType: "DocumentReference",
            date: art.publishedAt,
            description: art.title,
            content: [{ attachment: { url: art.coverImage, title: art.title } }],
            legacyData: { category: art.category, content: art.content, slug: art.slug }
        };

        // 🟢 HIPAA: Log IP address even for public guests accessing medical articles
        await writeAuditLog("GUEST", id, "READ_KB_ITEM", `Read article: ${art.title}`, { 
            region: userRegion, 
            ipAddress: req.ip 
        });
        
        res.json(fhirArticle);
    } catch (error) {
        res.status(500).json({ error: "Content currently unavailable" });
    }
};

router.get('/public/knowledge', getPublicKnowledge);
router.get('/public/knowledge/:id', getPublicArticle);

// ==========================================
// 🔒 2. SECURE BOUNDARY (Token Required)
// ==========================================
router.use(authMiddleware);

// ==========================================
// 🛡️ 3. PROTECTED ROUTES (HIPAA Enforced)
// ==========================================

// Dashboards & Analytics
router.get('/stats/demographics', getDemographics);
router.get('/search', searchPatients); 

// Registration (Requires Cognito Token)
router.post('/register-patient', createPatient); 
router.post('/', createPatient);

// Identity Verification
router.post('/identity/verify', verifyIdentity);

// Profile Management
router.get('/register-patient', getProfile); // Load own profile
router.get('/:userId', getPatientById);
router.get(['/patients/:id', '/:id'], getProfile);

router.put(['/patients/:id', '/:id'], updateProfile);

// GDPR Right to be Forgotten
router.delete('/me', deleteProfile);

export default router;
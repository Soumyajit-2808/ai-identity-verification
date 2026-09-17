const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

const app = express();

const PORT = 3000;
const AI_SERVICE_URL = "http://127.0.0.1:8001";

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: 10 * 1024 * 1024,
	},
});

app.use(cors());
app.use(express.json());

/*
 * Serve frontend
 */
app.use(express.static(path.join(__dirname, "..", "frontend")));

/*
 * Backend health
 */
app.get("/api/health", (req, res) => {
	res.json({
		status: "ok",
		service: "identity-verification-backend",
		ai_service: AI_SERVICE_URL,
	});
});

/*
 * Complete verification proxy
 *
 * Browser
 *   ↓
 * Node backend
 *   ↓
 * Python AI service
 */
app.post("/api/verify", upload.single("file"), async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).json({
				success: false,
				error: "Identity document is required.",
			});
		}

		const registrationName = req.body.registration_name || "";

		const minAge = Number(req.body.min_age || 18);

		const maxAge = Number(req.body.max_age || 100);

		/*
		 * Build multipart request for Python service
		 */
		const formData = new FormData();

		const blob = new Blob([req.file.buffer], { type: req.file.mimetype });

		formData.append("file", blob, req.file.originalname);

		formData.append("registration_name", registrationName);

		formData.append("min_age", String(minAge));

		formData.append("max_age", String(maxAge));

		/*
		 * Send document to AI service
		 */
		const response = await fetch(`${AI_SERVICE_URL}/api/verify`, {
			method: "POST",
			body: formData,
		});

		const data = await response.json();

		if (!response.ok) {
			return res.status(response.status).json(data);
		}

		res.json(data);
	} catch (error) {
		console.error("Verification proxy error:", error);

		res.status(500).json({
			success: false,
			error: "Unable to connect to the AI verification service.",
			details: error.message,
		});
	}
});

/*
 * Frontend fallback
 */


app.listen(PORT, () => {
	console.log(`Backend running on http://localhost:${PORT}`);
});

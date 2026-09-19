/**
 * Verification Orchestration Routes
 * Coordinates file ingestion, magic-byte inspection, storage, AI service inference,
 * persistent deduplication, transaction-level persistence, and review case triggers.
 */

const express = require('express');
const multer = require('multer');
const { transaction } = require('../db/connection');
const { getEventByCode } = require('../db/repositories/eventRepository');
const { createRegistration, updateRegistrationStatus } = require('../db/repositories/registrationRepository');
const { saveDocumentRecord } = require('../db/repositories/documentRepository');
const {
  checkDuplicateFile,
  checkIdentityReuse,
  registerIdentity,
  maskIdNumber,
} = require('../db/repositories/identityRegistryRepository');
const {
  createVerificationRequest,
  saveVerificationResult,
  saveVerificationSignals,
  getVerificationHistory,
  getVerificationDetails,
} = require('../db/repositories/verificationRepository');
const { createReviewCase } = require('../db/repositories/reviewCaseRepository');
const { logEvent } = require('../db/repositories/auditLogRepository');
const { validateMagicBytes, saveDocument } = require('../storage/documentStorage');

const router = express.Router();
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8001';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024, // 12 MB
  },
});

router.post(
  '/verify',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'selfie', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      const docFile = req.files?.file?.[0];
      const selfieFile = req.files?.selfie?.[0];

      if (!docFile) {
        return res.status(400).json({
          success: false,
          error: 'Identity document file is required.',
          code: 'MISSING_DOCUMENT',
        });
      }

      const registrationName = (req.body.registration_name || '').trim();
      if (!registrationName) {
        return res.status(400).json({
          success: false,
          error: 'Registration name is required.',
          code: 'MISSING_NAME',
        });
      }

      // 1. Validate Event
      const eventCode = req.body.event_code || 'HACK2026';
      const event = await getEventByCode(eventCode);
      if (!event) {
        return res.status(404).json({
          success: false,
          error: `Event '${eventCode}' not found or inactive.`,
          code: 'EVENT_NOT_FOUND',
        });
      }

      // 2. Validate Magic Bytes (Actual binary signature check)
      const docByteValidation = validateMagicBytes(docFile.buffer);
      if (!docByteValidation.isValid) {
        return res.status(400).json({
          success: false,
          error: `Invalid identity document file format: ${docByteValidation.error}`,
          code: 'INVALID_FILE_SIGNATURE',
        });
      }

      let selfieByteValidation = null;
      if (selfieFile) {
        selfieByteValidation = validateMagicBytes(selfieFile.buffer);
        if (!selfieByteValidation.isValid) {
          return res.status(400).json({
            success: false,
            error: `Invalid selfie file format: ${selfieByteValidation.error}`,
            code: 'INVALID_SELFIE_SIGNATURE',
          });
        }
      }

      // Check event selfie policy
      if (event.require_selfie && !selfieFile) {
        return res.status(400).json({
          success: false,
          error: 'A verification selfie is required for this event.',
          code: 'SELFIE_REQUIRED',
        });
      }

      // 3. Secure Document Storage
      const storedDoc = await saveDocument({
        buffer: docFile.buffer,
        originalFilename: docFile.originalname,
        mimeType: docByteValidation.detectedMime,
      });

      let storedSelfie = null;
      if (selfieFile) {
        storedSelfie = await saveDocument({
          buffer: selfieFile.buffer,
          originalFilename: selfieFile.originalname,
          mimeType: selfieByteValidation.detectedMime,
        });
      }

      // 4. Check Persistent Duplicate File Hash
      const duplicateFileCheck = await checkDuplicateFile(event.id, storedDoc.fileHash);

      // 5. Query AI Verification Service
      const formData = new FormData();
      const docBlob = new Blob([docFile.buffer], { type: docByteValidation.detectedMime });
      formData.append('file', docBlob, docFile.originalname);
      formData.append('registration_name', registrationName);
      formData.append('min_age', String(event.min_age));
      formData.append('max_age', String(event.max_age));
      formData.append('require_selfie', String(event.require_selfie));
      formData.append('strict_name_matching', String(event.strict_name_matching));

      if (selfieFile) {
        const selfieBlob = new Blob([selfieFile.buffer], { type: selfieByteValidation.detectedMime });
        formData.append('selfie', selfieBlob, selfieFile.originalname);
      }

      let aiResponse;
      try {
        const response = await fetch(`${AI_SERVICE_URL}/api/verify`, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.detail || `AI service returned HTTP ${response.status}`);
        }
        aiResponse = await response.json();
      } catch (aiErr) {
        console.error('[AI Service Error]', aiErr.message);
        return res.status(502).json({
          success: false,
          error: 'The AI verification engine is currently unreachable or failed processing.',
          code: 'AI_SERVICE_UNAVAILABLE',
          requestId: req.id,
        });
      }

      const aiVerification = aiResponse.verification;
      const extractedIdentity = aiVerification.extracted_identity || {};

      // 6. Check Persistent Identity Reuse in Database
      const identityReuseCheck = await checkIdentityReuse(
        event.id,
        extractedIdentity.id_number,
        registrationName
      );

      // 7. Synthesize Composite Signals & Final Decision
      const signals = [...aiVerification.signals];
      let finalDecision = aiVerification.decision;
      let finalRisk = aiVerification.risk_score;
      let finalConfidence = aiVerification.confidence_score;
      let summaryReasons = [aiVerification.summary_reason];

      // Add Duplicate File Signal
      if (duplicateFileCheck.isDuplicate) {
        signals.push({
          signal_type: 'DUPLICATE_FILE',
          signalType: 'DUPLICATE_FILE',
          status: 'REVIEW',
          score: 0.0,
          reason: `Exact document file hash matches an existing submission registered on ${duplicateFileCheck.createdAt}.`,
          details: { existingRegistrationId: duplicateFileCheck.existingRegistrationId },
        });
        finalDecision = 'REVIEW';
        finalRisk = Math.min(1.0, finalRisk + 0.35);
        summaryReasons.push('document file was previously submitted');
      } else {
        signals.push({
          signal_type: 'DUPLICATE_FILE',
          signalType: 'DUPLICATE_FILE',
          status: 'PASSED',
          score: 1.0,
          reason: 'No identical document file submission previously detected for this event.',
          details: { fileHash: storedDoc.fileHash },
        });
      }

      // Add Identity Reuse Signal
      if (identityReuseCheck.isReused) {
        if (identityReuseCheck.isSamePersonResubmission) {
          signals.push({
            signal_type: 'IDENTITY_REUSE',
            signalType: 'IDENTITY_REUSE',
            status: 'PASSED',
            score: 0.95,
            reason: 'ID number previously registered by the same participant (resubmission).',
            details: { previousName: identityReuseCheck.previousName },
          });
        } else {
          signals.push({
            signal_type: 'IDENTITY_REUSE',
            signalType: 'IDENTITY_REUSE',
            status: 'REVIEW',
            score: 0.0,
            reason: `Extracted ID number was previously registered under a different name ('${identityReuseCheck.previousName}').`,
            details: { previousName: identityReuseCheck.previousName },
          });
          finalDecision = 'REVIEW';
          finalRisk = Math.min(1.0, finalRisk + 0.40);
          summaryReasons.push('ID number reuse detected with conflicting participant name');
        }
      } else if (identityReuseCheck.canCheck) {
        signals.push({
          signal_type: 'IDENTITY_REUSE',
          signalType: 'IDENTITY_REUSE',
          status: 'PASSED',
          score: 1.0,
          reason: 'Extracted ID number has not been seen in any prior registration for this event.',
          details: {},
        });
      } else {
        signals.push({
          signal_type: 'IDENTITY_REUSE',
          signalType: 'IDENTITY_REUSE',
          status: 'REVIEW',
          score: 0.50,
          reason: identityReuseCheck.reason,
          details: {},
        });
      }

      // Recalculate confidence
      finalConfidence = Math.max(0.10, Math.min(0.98, aiVerification.evidence_score * (1.0 - (finalRisk * 0.7))));
      finalConfidence = Math.round(finalConfidence * 100) / 100;

      // Construct explainable summary
      const finalSummaryReason = finalDecision === 'REVIEW'
        ? `Manual review is required: ${summaryReasons.join('; ')}.`
        : aiVerification.summary_reason;

      // 8. Atomic Database Transaction Commit
      let responsePayload;
      await transaction(async (txClient) => {
        // Create registration
        const registration = await createRegistration(
          {
            eventId: event.id,
            registrationName,
            email: req.body.email || null,
            phone: req.body.phone || null,
          },
          txClient
        );

        // Save documents
        await saveDocumentRecord(
          {
            registrationId: registration.id,
            documentType: 'IDENTITY_DOCUMENT',
            fileHash: storedDoc.fileHash,
            storagePath: storedDoc.storagePath,
            originalFilename: docFile.originalname,
            mimeType: storedDoc.mimeType,
            fileSizeBytes: storedDoc.fileSizeBytes,
          },
          txClient
        );

        if (storedSelfie) {
          await saveDocumentRecord(
            {
              registrationId: registration.id,
              documentType: 'SELFIE',
              fileHash: storedSelfie.fileHash,
              storagePath: storedSelfie.storagePath,
              originalFilename: selfieFile.originalname,
              mimeType: storedSelfie.mimeType,
              fileSizeBytes: storedSelfie.fileSizeBytes,
            },
            txClient
          );
        }

        // Create verification request
        const verifReq = await createVerificationRequest(
          {
            registrationId: registration.id,
            eventId: event.id,
            requestIp: req.ip,
            userAgent: req.headers['user-agent'],
          },
          txClient
        );

        // Save verification result
        const verifResult = await saveVerificationResult(
          {
            requestId: verifReq.id,
            registrationId: registration.id,
            decision: finalDecision,
            confidenceScore: finalConfidence,
            riskScore: finalRisk,
            evidenceScore: aiVerification.evidence_score,
            summaryReason: finalSummaryReason,
            extractedIdentity,
          },
          txClient
        );

        // Save atomic signals
        await saveVerificationSignals(verifResult.id, signals, txClient);

        // Register in deduplication registry
        if (!duplicateFileCheck.isDuplicate || !identityReuseCheck.isReused) {
          try {
            await registerIdentity(
              {
                eventId: event.id,
                registrationId: registration.id,
                rawIdNumber: extractedIdentity.id_number,
                idType: extractedIdentity.id_type,
                registeredName: registrationName,
                documentFileHash: storedDoc.fileHash,
              },
              txClient
            );
          } catch (regErr) {
            // Concurrent race condition prevented by unique constraint
            console.warn('[Identity Registry Concurrency Lock]', regErr.message);
          }
        }

        // Update registration status
        let regStatus = 'PENDING';
        if (finalDecision === 'ELIGIBLE') regStatus = 'VERIFIED';
        else if (finalDecision === 'REVIEW') regStatus = 'REVIEW_REQUIRED';
        else if (finalDecision === 'INELIGIBLE') regStatus = 'REJECTED';
        await updateRegistrationStatus(registration.id, regStatus, txClient);

        // Create review case if review is required
        let reviewCaseId = null;
        if (finalDecision === 'REVIEW') {
          const priority = (finalRisk >= 0.50 || identityReuseCheck.isReused) ? 'HIGH' : 'MEDIUM';
          const rCase = await createReviewCase(
            {
              resultId: verifResult.id,
              registrationId: registration.id,
              eventId: event.id,
              priority,
              reviewerNotes: finalSummaryReason,
            },
            txClient
          );
          reviewCaseId = rCase.id;
        }

        // Audit log
        await logEvent(
          {
            action: 'VERIFICATION_EXECUTED',
            entityType: 'VERIFICATION_REQUEST',
            entityId: verifReq.id,
            eventId: event.id,
            details: {
              decision: finalDecision,
              confidence: finalConfidence,
              risk: finalRisk,
              signalsCount: signals.length,
            },
            ipAddress: req.ip,
          },
          txClient
        );

        responsePayload = {
          success: true,
          decision: finalDecision,
          confidence_score: finalConfidence,
          evidence_score: aiVerification.evidence_score,
          risk_score: finalRisk,
          summary_reason: finalSummaryReason,
          requestId: verifReq.id,
          registrationId: registration.id,
          reviewCaseId,
          identity: {
            name: extractedIdentity.name || 'Not detected',
            date_of_birth: extractedIdentity.date_of_birth || 'Not detected',
            calculated_age: extractedIdentity.calculated_age,
            id_number_masked: maskIdNumber(extractedIdentity.id_number),
            id_type: extractedIdentity.id_type || 'UNKNOWN',
            institution: extractedIdentity.institution || 'Not detected',
          },
          signals,
        };
      });

      res.json(responsePayload);
    } catch (err) {
      next(err);
    }
  }
);

router.get('/verifications', async (req, res, next) => {
  try {
    const { eventId, limit } = req.query;
    const history = await getVerificationHistory(eventId || null, limit ? Number(limit) : 50);
    res.json({ success: true, count: history.length, verifications: history });
  } catch (err) {
    next(err);
  }
});

router.get('/verifications/:id', async (req, res, next) => {
  try {
    const details = await getVerificationDetails(req.params.id);
    if (!details) {
      return res.status(404).json({ success: false, error: 'Verification record not found.' });
    }
    res.json({ success: true, verification: details });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

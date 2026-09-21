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
const identityRegistryRepository = require('../db/repositories/identityRegistryRepository');
const {
  checkDuplicateFile,
  checkIdentityReuse,
  maskIdNumber,
  isUniqueConstraintViolation,
} = identityRegistryRepository;
const {
  createVerificationRequest,
  saveVerificationResult,
  saveVerificationSignals,
  getVerificationHistory,
  getVerificationDetails,
} = require('../db/repositories/verificationRepository');
const { createReviewCase } = require('../db/repositories/reviewCaseRepository');
const { logEvent } = require('../db/repositories/auditLogRepository');
const { validateMagicBytes, saveDocument, deleteDocument } = require('../storage/documentStorage');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8001';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024, // 12 MB
  },
});

/**
 * Sanitizes verification signals for public applicant-facing responses,
 * preventing leakage of prior participants' PII, registration IDs, or database records.
 * Internal evidence is preserved in the database for reviewer/admin workflows.
 */
function sanitizeSignalsForPublicResponse(signals) {
  if (!Array.isArray(signals)) return [];
  return signals.map((sig) => {
    const sanitized = { ...sig };
    const sigType = (sanitized.signal_type || sanitized.signalType || '').toUpperCase();
    const details = sanitized.details ? { ...sanitized.details } : {};

    // Remove any sensitive cross-participant reference fields unconditionally
    delete details.existingRegistrationId;
    delete details.existingRecord;
    delete details.previousName;
    delete details.registered_name;

    if (sigType === 'DUPLICATE_FILE') {
      if (sanitized.status === 'REVIEW') {
        sanitized.reason = 'This document has already been submitted for this event.';
      }
    } else if (sigType === 'IDENTITY_REUSE') {
      if (sanitized.status === 'REVIEW') {
        sanitized.reason = 'The extracted ID number was previously registered for this event and requires manual review.';
      }
    }

    sanitized.details = details;
    return sanitized;
  });
}

router.post(
  '/verify',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'document', maxCount: 1 },
    { name: 'selfie', maxCount: 1 },
  ]),
  async (req, res, next) => {
    let storedDoc = null;
    let storedSelfie = null;
    let transactionCommitted = false;

    try {
      const docFile = req.files?.file?.[0] || req.files?.document?.[0];
      const selfieFile = req.files?.selfie?.[0];

      if (!docFile) {
        return res.status(400).json({
          success: false,
          error: 'Identity document file is required.',
          code: 'MISSING_DOCUMENT',
        });
      }

      const registrationName = (req.body.registration_name || req.body.fullName || req.body.name || '').trim();
      if (!registrationName) {
        return res.status(400).json({
          success: false,
          error: 'Registration name is required.',
          code: 'MISSING_NAME',
        });
      }

      // 1. Validate Event
      const eventCode = req.body.event_code || req.body.eventId || 'HACK2026';
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
        const isPdf = docByteValidation.detectedMime === 'application/pdf';
        return res.status(400).json({
          success: false,
          error: `Invalid identity document file format: ${docByteValidation.error}`,
          code: isPdf ? 'PDF_NOT_SUPPORTED' : 'INVALID_FILE_SIGNATURE',
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


      // 3. Secure Document Storage
      storedDoc = await saveDocument({
        buffer: docFile.buffer,
        originalFilename: docFile.originalname,
        mimeType: docByteValidation.detectedMime,
      });

      if (selfieFile) {
        storedSelfie = await saveDocument({
          buffer: selfieFile.buffer,
          originalFilename: selfieFile.originalname,
          mimeType: selfieByteValidation.detectedMime,
        });
      }

      // 4. Check Persistent Duplicate File Hash
      let duplicateFileCheck = await checkDuplicateFile(event.id, storedDoc.fileHash);

      // 5. Query AI Verification Service
      const formData = new FormData();
      const docBlob = new Blob([docFile.buffer], { type: docByteValidation.detectedMime });
      formData.append('file', docBlob, docFile.originalname);
      formData.append('registration_name', registrationName);
      formData.append('min_age', String(event.min_age));
      formData.append('max_age', String(event.max_age));
      formData.append('require_selfie', String(event.require_selfie));
      formData.append('strict_name_matching', String(event.strict_name_matching));
      formData.append('allowed_id_types', (event.allowed_id_types || []).join(','));

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
        // Clean up temporary documents to prevent orphans
        if (storedDoc) await deleteDocument(storedDoc.storagePath).catch(() => {});
        if (storedSelfie) await deleteDocument(storedSelfie.storagePath).catch(() => {});
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
      let identityReuseCheck = await checkIdentityReuse(
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
        if (finalDecision !== 'INELIGIBLE') {
          finalDecision = 'REVIEW';
        }
        finalRisk = Math.round(Math.min(1.0, finalRisk + 0.35) * 100) / 100;
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
          if (finalDecision !== 'INELIGIBLE') {
            finalDecision = 'REVIEW';
          }
          finalRisk = Math.round(Math.min(1.0, finalRisk + 0.40) * 100) / 100;
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
        if (finalDecision !== 'INELIGIBLE') {
          finalDecision = 'REVIEW';
        }
        finalRisk = Math.round(Math.min(1.0, finalRisk + 0.30) * 100) / 100;
        summaryReasons.push(identityReuseCheck.reason);
      }

      // Recalculate confidence
      finalConfidence = Math.max(0.10, Math.min(0.98, aiVerification.evidence_score * (1.0 - (finalRisk * 0.7))));
      finalConfidence = Math.round(finalConfidence * 100) / 100;

      // Construct explainable summary
      let finalSummaryReason = finalDecision === 'REVIEW'
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
            eventId: event.id,
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
              eventId: event.id,
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

        // 1. Re-check exact duplicate file inside transaction to eliminate race conditions
        if (!duplicateFileCheck.isDuplicate) {
          const inTxDupCheck = await checkDuplicateFile(event.id, storedDoc.fileHash, txClient);
          if (inTxDupCheck.isDuplicate) {
            duplicateFileCheck = inTxDupCheck;
            if (finalDecision !== 'INELIGIBLE') {
              finalDecision = 'REVIEW';
            }
            finalRisk = Math.round(Math.min(1.0, finalRisk + 0.35) * 100) / 100;
            finalConfidence = Math.max(0.10, Math.min(0.98, aiVerification.evidence_score * (1.0 - (finalRisk * 0.7))));
            finalConfidence = Math.round(finalConfidence * 100) / 100;
            finalSummaryReason = (finalSummaryReason.includes('Manual review') ? finalSummaryReason : `Manual review is required: ${finalSummaryReason}`) + '; document file was previously submitted (concurrency detected)';
            const dupIdx = signals.findIndex(s => s.signal_type === 'DUPLICATE_FILE' || s.signalType === 'DUPLICATE_FILE');
            const dupSignal = {
              signal_type: 'DUPLICATE_FILE',
              signalType: 'DUPLICATE_FILE',
              status: 'REVIEW',
              score: 0.0,
              reason: `Exact document file hash matches an existing submission registered on ${inTxDupCheck.createdAt}.`,
              details: { existingRegistrationId: inTxDupCheck.existingRegistrationId },
            };
            if (dupIdx >= 0) signals[dupIdx] = dupSignal;
            else signals.push(dupSignal);
          }
        }

        // 2. Re-check identity reuse inside transaction to eliminate check-then-write race
        if (extractedIdentity.id_number && !identityReuseCheck.isReused) {
          const inTxReuseCheck = await checkIdentityReuse(
            event.id,
            extractedIdentity.id_number,
            registrationName,
            txClient
          );
          if (inTxReuseCheck.isReused) {
            identityReuseCheck = inTxReuseCheck;
            if (!inTxReuseCheck.isSamePersonResubmission) {
              if (finalDecision !== 'INELIGIBLE') {
                finalDecision = 'REVIEW';
              }
              finalRisk = Math.round(Math.min(1.0, finalRisk + 0.40) * 100) / 100;
              finalConfidence = Math.max(0.10, Math.min(0.98, aiVerification.evidence_score * (1.0 - (finalRisk * 0.7))));
              finalConfidence = Math.round(finalConfidence * 100) / 100;
              finalSummaryReason = (finalSummaryReason.includes('Manual review') ? finalSummaryReason : `Manual review is required: ${finalSummaryReason}`) + '; ID number reuse detected with conflicting participant name (concurrency detected)';
              const reuseIdx = signals.findIndex(s => s.signal_type === 'IDENTITY_REUSE' || s.signalType === 'IDENTITY_REUSE');
              const reuseSignal = {
                signal_type: 'IDENTITY_REUSE',
                signalType: 'IDENTITY_REUSE',
                status: 'REVIEW',
                score: 0.0,
                reason: `Extracted ID number was previously registered under a different name ('${inTxReuseCheck.previousName}').`,
                details: { previousName: inTxReuseCheck.previousName },
              };
              if (reuseIdx >= 0) signals[reuseIdx] = reuseSignal;
              else signals.push(reuseSignal);
            }
          }
        }

        // 3. Register in deduplication registry with authoritative DB unique constraints
        if (!duplicateFileCheck.isDuplicate && (!identityReuseCheck.isReused || identityReuseCheck.isSamePersonResubmission)) {
          const regResult = await identityRegistryRepository.registerIdentity(
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

          if (!regResult.registered && regResult.conflict) {
            // Concurrent race condition prevented by database unique constraint
            if (!regResult.isSamePersonResubmission) {
              if (finalDecision !== 'INELIGIBLE') {
                finalDecision = 'REVIEW';
              }
              const conflictSignalType = regResult.conflictType === 'DUPLICATE_FILE' ? 'DUPLICATE_FILE' : 'IDENTITY_REUSE';
              if (conflictSignalType === 'DUPLICATE_FILE') {
                duplicateFileCheck = { isDuplicate: true, existingRegistrationId: regResult.existingRecord?.registration_id };
              } else {
                identityReuseCheck = { isReused: true, previousName: regResult.existingRecord?.registered_name };
              }
              const riskInc = conflictSignalType === 'DUPLICATE_FILE' ? 0.35 : 0.40;
              finalRisk = Math.round(Math.min(1.0, finalRisk + riskInc) * 100) / 100;
              finalConfidence = Math.max(0.10, Math.min(0.98, aiVerification.evidence_score * (1.0 - (finalRisk * 0.7))));
              finalConfidence = Math.round(finalConfidence * 100) / 100;
              finalSummaryReason = (finalSummaryReason.includes('Manual review') ? finalSummaryReason : `Manual review is required: ${finalSummaryReason}`) + `; ${conflictSignalType.toLowerCase().replace('_', ' ')} prevented by database constraint`;

              const sigIdx = signals.findIndex(s => s.signal_type === conflictSignalType || s.signalType === conflictSignalType);
              const conflictSig = {
                signal_type: conflictSignalType,
                signalType: conflictSignalType,
                status: 'REVIEW',
                score: 0.0,
                reason: conflictSignalType === 'DUPLICATE_FILE'
                  ? 'Exact document file hash matches an existing submission (enforced by database constraint).'
                  : `Extracted ID number was previously registered under a different name ('${regResult.existingRecord?.registered_name || 'conflicting identity'}') (enforced by database constraint).`,
                details: { existingRecord: regResult.existingRecord },
              };
              if (sigIdx >= 0) signals[sigIdx] = conflictSig;
              else signals.push(conflictSig);
            }
          }
        }

        // 4. Save verification result with final, derived decision and scores
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

        // 5. Save atomic signals reflecting final state
        await saveVerificationSignals(verifResult.id, signals, txClient);

        // 6. Update registration status
        let regStatus = 'PENDING';
        if (finalDecision === 'ELIGIBLE') regStatus = 'VERIFIED';
        else if (finalDecision === 'REVIEW') regStatus = 'REVIEW_REQUIRED';
        else if (finalDecision === 'INELIGIBLE') regStatus = 'REJECTED';
        await updateRegistrationStatus(registration.id, regStatus, txClient);

        // 7. Create review case if review is required
        let reviewCaseId = null;
        if (finalDecision === 'REVIEW') {
          const priority = (finalRisk >= 0.50 || identityReuseCheck.isReused || duplicateFileCheck.isDuplicate) ? 'HIGH' : 'MEDIUM';
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

        // 8. Audit log with authoritative organization ID
        await logEvent(
          {
            organizationId: event.organization_id,
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
          confidence: finalConfidence,
          evidence_score: aiVerification.evidence_score,
          evidenceScore: aiVerification.evidence_score,
          risk_score: finalRisk,
          riskScore: finalRisk,
          summary_reason: finalSummaryReason,
          summaryReason: finalSummaryReason,
          reasons: summaryReasons,
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
          extractedData: {
            name: extractedIdentity.name || 'Not detected',
            dob: extractedIdentity.date_of_birth || 'Not detected',
            idNumber: maskIdNumber(extractedIdentity.id_number),
            idType: extractedIdentity.id_type || 'UNKNOWN',
            institution: extractedIdentity.institution || 'Not detected',
          },
          signals: sanitizeSignalsForPublicResponse(signals),
        };
        transactionCommitted = true;
      });

      res.json(responsePayload);
    } catch (err) {
      if (!transactionCommitted) {
        if (storedDoc) await deleteDocument(storedDoc.storagePath).catch(() => {});
        if (storedSelfie) await deleteDocument(storedSelfie.storagePath).catch(() => {});
      }
      next(err);
    }
  }
);

const handleVerificationHistory = async (req, res, next) => {
  try {
    const { eventId, limit } = req.query;
    const history = await getVerificationHistory({
      eventId: eventId || null,
      organizationId: req.user.organization_id || null,
      limit: limit ? Number(limit) : 50,
    });
    res.json({ success: true, count: history.length, verifications: history, data: history });
  } catch (err) {
    next(err);
  }
};

router.get('/verifications', requireAuth, requireRole(['reviewer', 'admin']), handleVerificationHistory);
router.get('/history', requireAuth, requireRole(['reviewer', 'admin']), handleVerificationHistory);

router.get('/verifications/:id', requireAuth, requireRole(['reviewer', 'admin']), async (req, res, next) => {
  try {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid verification request ID format.' });
    }

    const details = await getVerificationDetails(req.params.id, req.user.organization_id || null);
    if (!details) {
      return res.status(404).json({ success: false, error: 'Verification record not found or unauthorized.' });
    }
    res.json({ success: true, verification: details });
  } catch (err) {
    next(err);
  }
});

router.sanitizeSignalsForPublicResponse = sanitizeSignalsForPublicResponse;

module.exports = router;

# HVAC AI Front-Office — Build Specification

Derived from `hvac-ai-next-gen-architecture.md` research synthesis.
Live document. Update as realities surface.

---

## Architecture Layers

| Layer | Name | Status | Notes |
|---|---|---|---|
| 0 | Deterministic Safety Gate | 🟢 DONE | Regex layer — 23 patterns, 33 tests, hard gate before LLM |
| 1 | Omnichannel Intake | 🟢 DONE | Express + Twilio SMS webhook, queue store, TwiML helpers, Twilio sig validation |
| 2 | Conversational Core | 🟢 DONE | Rule-based classifier + LLM classifier, session store, price gate, response builder |
| 3 | FSM Integration | 🟢 DONE | Jobber GraphQL client + OAuth, FSM adapter interface, MockFsmAdapter, FSM router, 22 tests |
| 4 | IoT Predictive Triage | ✅ DONE | Ecobee webhook → signal extraction → proactive leads → outbound SMS, 21+ tests |
| 5 | Lifecycle Automation | ✅ DONE | RenewalOutreachEngine, RouteCluster, daily cron script, 14 tests |
| 6 | Compliance Substrate | ✅ DONE | ConsentStore, TCPA stop-word handler, CIPA disclosure, 32 tests |

---

## Layer 0 — Deterministic Safety Gate (Differentiator)

### Purpose
Never let the LLM be the only thing between a gas-leak report and a routine appointment.
Run every inbound transcript through a deterministic keyword layer BEFORE LLM classification.

### Keywords (Phase 1 — expand with HVAC tech review)
```
EMERGENCY_PATTERNS = [
  /gas\s*smell/i, /smells?\s*like\s*gas/i,
  /carbon\s*monoxide/i, /co\s*detector/i, /co\s*alarm/i,
  /co2\s*detector/i, /co2\s*alarm/i,
  /smoke/i, /fire/i, /flames/i,
  /sparking/i, /sparking/i, /short\s*circuit/i,
  /burning\s*smell/i, /electrical\s*burn/i,
  /gas\s*leak/i, /gas\s*line/i,
  /refrigerant\s*leak/i, /freon\s*leak/i,
  /heat\s*not\s*working/i, /no\s*heat.*emergency/i,
  /ac\s*not\s*working.*elderly/i, /child.*heat/i,
  /unconscious/i, /gas\s*poisoning/i,
  /explosion/i, /rupture/i,
]
```

### Behavior on Hit
1. Override any LLM urgency classification
2. Return escalation response: fixed string, never generated
3. Log raw trigger + full transcript for audit
4. (v1) Send SMS/email to on-call dispatcher via webhook
5. (v2) Direct PSTN transfer or page

### Escalation Response (fixed, never generated)
```
"I've received what may be a gas or carbon monoxide emergency from this location.
I'm connecting you with our emergency line right now. Please leave the building
and stay outside until our technician arrives. Call 911 if you need immediate help."
```

### Audit Log Schema
```json
{
  "event": "safety_gate_triggered",
  "timestamp": "ISO8601",
  "channel": "voice|sms|chat",
  "tenant_id": "string",
  "trigger_pattern": "string (regex that matched)",
  "trigger_text": "string (what was matched)",
  "full_transcript": "string",
  "llm_urgency_classification": "string (what LLM said, if run)",
  "escalation_action": "dispatcher_notified|transferring|911_advised",
  "disposition": "pending_review|resolved"
}
```

---

## Layer 1 — Omnichannel Intake

### Channels
- Voice: Twilio Media Streams → transcription
- SMS: Twilio SMS webhooks
- Web Chat: custom JS widget / intercom-style
- Third-party leads: Google LSA, Yelp, Thumbtack, Angi (aggregated via webhooks)

### Unified Queue Entry Schema
```json
{
  "id": "uuid",
  "channel": "voice|sms|chat|google_lsa|yelp|thumbtack|angi",
  "tenant_id": "string",
  "raw_input": "string",
  "transcript": "string (for voice)",
  "caller_phone": "string (E.164)",
  "service_address": "string",
  "contact_name": "string",
  "received_at": "ISO8601",
  "safety_gate_passed": "boolean",
  "safety_gate_result": "object|null",
  "llm_classification": "object|null",
  "status": "queued|qualified|escalated|scheduled|closed"
}
```

### Rule
Every inbound channel passes through Layer 0 before anything else.
Web-chat and SMS free-text included — safety concern applies to any channel.

---

## Layer 2 — Conversational Core

### Price Gate
- Model **never generates a price** unless retrieving from contractor's pricebook via FSM API
- Fallback string (fixed, pre-approved): "A technician will provide an exact quote on-site after diagnosing the issue."
- Membership/plan-tier lookup → query FSM for active-agreement status before any discount mention
- Never let model assume or infer tier from conversation context

### System Prompt Grounding
HVAC term glossary embedded in prompt:
```
TXV, reversing valve, aux heat, auxiliary heat, short-cycling,
short cycle, compressor lockout, demand-defrost, dual-fuel,
heat pump, straight cool, packaged unit, split system,
scroll compressor, reciprocating compressor, SEER, HSPF, AFUE,
evaporator coil, condenser coil, condensing unit, air handler,
furnace, boiler, ductwork, flex duct, static pressure,
refrigerant, R-410A, R-22, Freon, purge, vacuum pump,
manifold gauge, service valve, thermostat wire, low voltage,
24V, sequencer, contactor, capacitor, hard start kit
```

### Classification Schema (LLM output)
```json
{
  "intent": "schedule_service|quote_request|membership|inquiry|emergency|other",
  "urgency": "emergency|urgent|routine|low",
  "job_type": "string|null",
  "equipment_type": "string|null",
  "pricebook_match": "object|null",
  "needs_callback": "boolean",
  "callback_reason": "string|null"
}
```

---

## Layer 3 — FSM Integration

### Tier 1 (v1 — front-door lead injection)
All three platforms: push qualified lead into FSM intake queue for human review.

### Tier 2 (v2 — deep sync)
- ServiceTitan only: live pricebook reads, membership tier checks, dispatch-board injection
- Jobber/HCP: Tier 1 only for now

### Integration Order
1. **Jobber** — GraphQL API, OAuth 2.0, no review gate below 5 connected accounts
2. **Housecall Pro** — Public API gated behind MAX plan (needs developer)
3. **ServiceTitan** — Marketplace certification, sandbox, multi-week onboarding

### Jobber v1 Endpoints
```
POST /graphql — create job / push lead
GET /graphql — customer lookup by phone/email
GET /graphql — pricebook by job type
```

---

## Layer 4 — IoT Predictive Triage ✅ DONE

### Buildable Signals (from thermostat telemetry)
- Short-cycling (compressor cycles < 5 min on, short off)
- Runtime/cycle-length anomalies vs. baseline
- Failure-to-reach-setpoint
- Auxiliary-heat overshoot (failing heat pump / reversing valve)
- Humidity elevation trends

### Sources (by richness)
1. **Ecobee** — Runtime Report API (richest, 15-min intervals)
2. **Nest** — thermostat_traits + ambient_temperature_sensor (less granular)
3. **Honeywell/Resideo** — usermanagement.devices (limited)

### NOT Extractable (requires truck roll)
- Refrigerant charge faults
- Airflow/duct static pressure faults
- Compressor electrical faults

### Output Rule
System generates proactive service ticket: "This system is short-cycling — worth a look."
Never: "Your reversing valve has failed."

### Consent Model
Itemized template (not bundled in ToS):
- Customer name
- Service address
- Thermostat serial number
- Runtime data
- Temperature/humidity data
- Setpoints

---

## Layer 5 — Lifecycle Automation ✅ DONE

### Maintenance-Plan Automation
- Renewal outreach: calendar-triggered or Layer 4 telemetry-triggered
- Route-clustering by zip code to avoid renewal call floods
- Seasonal tune-up sequencing

### Demand-Response Positioning
Contractors do NOT earn DR dispatch revenue.
Value: rebate capture at point-of-sale + same telemetry reuse.

---

## Layer 6 — Compliance Substrate ✅ DONE

### CIPA § 631(a)
- Explicit disclosure before any call processing
- Disclosure must happen BEFORE transcription/AI analysis, not after

### TCPA
- "STOP" reply on any channel revokes consent everywhere
- Must be honored within 10 business days
- Cross-channel consent flag on customer record

### All-Party Consent Standard
- Default everywhere (can't guarantee single-party state for all callers)
- Hard-coded first utterance on voice: "This call is being handled by an automated assistant and may be recorded."

### Data Model: Consent Record
```json
{
  "id": "uuid",
  "customer_id": "uuid",
  "channel": "voice|sms|chat|thermostat",
  "consent_type": "call_recording|ai_analysis|marketing|thermostat_telemetry",
  "granted": "boolean",
  "granted_at": "ISO8601",
  "revoked_at": "ISO8601|null",
  "scope": "string (itemized description)",
  "ip_address": "string|null",
  "source": "web_form|verbal|written|sms_reply"
}
```

---

## Build Phases

### Phase 1 — Foundation (MVP)
- Layer 0 (Safety Gate) as standalone module
- Layer 1 intake webhook (SMS first — Twilio)
- Layer 2 conversational core with price gate
- Logging + audit trail
- No FSM yet — manual intake queue

### Phase 2 — FSM Integration
- Jobber GraphQL integration (Tier 1 only)
- Lead push to Jobber queue
- Customer lookup

### Phase 3 — Omnichannel
- Voice (Twilio Media Streams)
- Web chat widget
- Third-party lead ingestion

### Phase 4 — IoT + Lifecycle
- Ecobee integration
- Predictive signal extraction
- Renewal outreach automation

### Phase 5 — Deep FSM + Compliance
- ServiceTitan integration
- Full compliance audit trail
- Consent management system

---

## Non-Goals (Do Not Build)
- DR revenue share feature
- AI-generated price quotes without pricebook retrieval
- Refrigerant/airflow/electrical fault "diagnoses"
- Hallucinated urgency classifications

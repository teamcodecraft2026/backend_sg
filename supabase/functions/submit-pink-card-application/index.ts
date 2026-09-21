// supabase/functions/submit-pink-card-application/index.ts
//
// Replaces check-pink-card. Same PAN lookup + eligibility computation,
// but now:
//   - takes the full 4-step form (name/phone/aadhaar/pan/state)
//   - stores the result as a PENDING application (status: "submitted")
//   - does NOT return eligibility to the citizen — that only happens once
//     an officer approves/denies it via officer-decide-application.
//
// Deploy: supabase functions deploy submit-pink-card-application

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const encoder = new TextEncoder();
const keyData = encoder.encode(Deno.env.get("JWT_SECRET")!);
const cryptoKey = await crypto.subtle.importKey(
  "raw",
  keyData,
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["verify"],
);

const THRESHOLD = 250000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const AADHAAR_RE = /^\d{12}$/;
const PHONE_RE = /^[6-9]\d{9}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- 1. Authenticate caller via our own JWT (from verify-otp) ----
    const authHeader = req.headers.get("Authorization") || "";
    const userToken = authHeader.replace("Bearer ", "");

    let payload;
    try {
      payload = await verify(userToken, cryptoKey);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session token" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const user_id = payload.sub as string;

    // ---- 2. Validate the full form payload ----
    const body = await req.json();
    const full_name = (body.full_name ?? "").toString().trim();
    const phone = (body.phone ?? "").toString().trim();
    const aadhaar = (body.aadhaar ?? "").toString().trim();
    const pan = (body.pan ?? "").toString().trim().toUpperCase();
    const state = (body.state ?? "").toString().trim();

    const errors: string[] = [];
    if (!full_name) errors.push("full_name is required");
    if (!PHONE_RE.test(phone))
      errors.push("phone must be a valid 10-digit number");
    if (!AADHAAR_RE.test(aadhaar))
      errors.push("aadhaar must be exactly 12 digits");
    if (!PAN_RE.test(pan))
      errors.push("pan must be a valid PAN (e.g. ABCDE1234F)");
    if (!state) errors.push("state is required");

    if (errors.length > 0) {
      return new Response(JSON.stringify({ error: errors.join(", ") }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- 3. Look up "government income database" (dummy PAN table) ----
    const { data: record, error: lookupError } = await supabase
      .from("pink_card_income_records")
      .select("*")
      .eq("pan", pan)
      .single();

    // computed_* fields are the SYSTEM'S SUGGESTION for the officer.
    // They are stored but never returned to the citizen from this endpoint.
    let computed: {
      eligible: boolean | null;
      gender: string | null;
      annual_income: number | null;
      threshold: number;
      gap: number | null;
      reason_code: string;
      reason_message: string;
    };
    let source: "auto_match" | "manual";

    if (lookupError || !record) {
      source = "manual";
      computed = {
        eligible: null,
        gender: null,
        annual_income: null,
        threshold: THRESHOLD,
        gap: null,
        reason_code: "INELIGIBLE_NO_RECORD",
        reason_message:
          "No income record found for this PAN — requires manual review.",
      };
    } else {
      source = "auto_match";
      if (record.gender !== "F") {
        computed = {
          eligible: false,
          gender: record.gender,
          annual_income: record.annual_income,
          threshold: THRESHOLD,
          gap: null,
          reason_code: "INELIGIBLE_GENDER",
          reason_message: "Pink Card is only available to female applicants.",
        };
      } else if (record.annual_income > THRESHOLD) {
        const gap = record.annual_income - THRESHOLD;
        computed = {
          eligible: false,
          gender: record.gender,
          annual_income: record.annual_income,
          threshold: THRESHOLD,
          gap,
          reason_code: "INELIGIBLE_INCOME_HIGH",
          reason_message: `Income exceeds the threshold by ₹${gap.toLocaleString("en-IN")}.`,
        };
      } else {
        const gap = record.annual_income - THRESHOLD; // negative = under threshold
        computed = {
          eligible: true,
          gender: record.gender,
          annual_income: record.annual_income,
          threshold: THRESHOLD,
          gap,
          reason_code: "ELIGIBLE_INCOME_GENDER",
          reason_message: `Eligible: income is ₹${Math.abs(gap).toLocaleString("en-IN")} below the threshold.`,
        };
      }
    }

    // ---- 4. Save as a PENDING application ----
    const { data: savedApp, error: insertError } = await supabase
      .from("pink_card_applications")
      .insert({
        user_id,
        full_name,
        phone,
        aadhaar,
        pan,
        state,
        status: "submitted",
        source,
        eligible: computed.eligible,
        gender: computed.gender,
        annual_income: computed.annual_income,
        threshold: computed.threshold,
        gap: computed.gap,
        reason_code: computed.reason_code,
        reason_message: computed.reason_message,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // ---- 5. Return ONLY submission confirmation — no eligibility yet ----
    return new Response(
      JSON.stringify({
        success: true,
        application_id: savedApp.id,
        status: "submitted",
        message:
          "Your application has been forwarded to a Verifying Officer for review.",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

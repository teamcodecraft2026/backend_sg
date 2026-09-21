// supabase/functions/get-application-status/index.ts
//
// Citizen-facing. Given an application_id, returns its status.
// Full eligibility breakdown is only included once status is
// "eligible" or "not_eligible" (i.e. an officer has decided).
//
// GET /get-application-status?application_id=...
//
// Deploy: supabase functions deploy get-application-status

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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userToken = authHeader.replace("Bearer ", "");

    let user_id: string | null = null;
    if (userToken) {
      try {
        const payload = await verify(userToken, cryptoKey);
        user_id = payload.sub as string;
      } catch {
        /* token expired or missing — still allow status check by ID */
      }
    }

    const url = new URL(req.url);
    const application_id = url.searchParams.get("application_id");
    if (!application_id) {
      return new Response(
        JSON.stringify({ error: "application_id is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: app, error } = await supabase
      .from("pink_card_applications")
      .select("*")
      .eq("id", application_id)
      .single();

    if (error || !app) {
      return new Response(JSON.stringify({ error: "Application not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Still pending — don't leak the officer's working data
    if (app.status === "submitted") {
      return new Response(
        JSON.stringify({
          success: true,
          application_id: app.id,
          status: "submitted",
          message: "Your application is with a Verifying Officer for review.",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Decided — return the final verdict (using manual values if this was a
    // manual-review application, else the auto-computed ones)
    const eligible = app.status === "eligible";
    const annual_income =
      app.source === "manual" ? app.manual_income : app.annual_income;
    const reason_message =
      app.source === "manual" ? app.manual_reason : app.reason_message;

    return new Response(
      JSON.stringify({
        success: true,
        application_id: app.id,
        status: app.status,
        eligible,
        pan: app.pan,
        gender: app.gender,
        annual_income,
        threshold: app.threshold,
        gap: app.gap,
        reason_code: app.reason_code,
        reason_message,
        decided_at: app.decided_at,
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

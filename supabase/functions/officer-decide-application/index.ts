// supabase/functions/officer-decide-application/index.ts
//
// Officer/admin-facing. Approves or denies a Pink Card application.
//
// POST /officer-decide-application
// body: {
//   application_id: string,
//   decision: "approve" | "deny",
//   manual_gender?: "Male" | "Female",  // required for manual-review applications
//   manual_income?: number,              // required for manual-review applications
//   manual_reason?: string,              // required for manual-review applications
// }
//
// Server-side enforced rule:
//   - if source === "auto_match" and the system's own computed eligibility
//     was false, "approve" is rejected — only "deny" is allowed. This can't
//     be bypassed from the client.
//
// Deploy: supabase functions deploy officer-decide-application

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
    // ---- Auth + role check ----
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
    const officer_id = payload.sub as string;

    const { data: caller, error: callerError } = await supabase
      .from("users")
      .select("role")
      .eq("id", officer_id)
      .single();

    if (callerError || !caller || !["officer", "admin"].includes(caller.role)) {
      return new Response(
        JSON.stringify({ error: "Forbidden: officer access required" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- Parse + validate body ----
    const body = await req.json();
    const application_id = (body.application_id ?? "").toString();
    const decision = body.decision; // "approve" | "deny"
    const manual_gender = body.manual_gender
      ? String(body.manual_gender).trim()
      : null;
    const manual_income =
      body.manual_income != null ? Number(body.manual_income) : null;
    const manual_reason = body.manual_reason
      ? String(body.manual_reason).trim()
      : null;

    if (!application_id) {
      return new Response(
        JSON.stringify({ error: "application_id is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    if (decision !== "approve" && decision !== "deny") {
      return new Response(
        JSON.stringify({ error: "decision must be 'approve' or 'deny'" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: app, error: fetchError } = await supabase
      .from("pink_card_applications")
      .select("*")
      .eq("id", application_id)
      .single();

    if (fetchError || !app) {
      return new Response(JSON.stringify({ error: "Application not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (app.status !== "submitted") {
      return new Response(
        JSON.stringify({
          error: `Application already decided (status: ${app.status})`,
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- Enforce: auto_match + system says not eligible => deny only ----
    if (
      app.source === "auto_match" &&
      app.eligible === false &&
      decision === "approve"
    ) {
      return new Response(
        JSON.stringify({
          error:
            "This PAN matched government income records and was found ineligible. Only 'deny' is allowed.",
        }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ---- Manual-review applications: require gender + income + reason ----
    if (app.source === "manual") {
      if (!manual_gender || !["Male", "Female"].includes(manual_gender)) {
        return new Response(
          JSON.stringify({
            error:
              "manual_gender (Male or Female) is required for manually-reviewed applications",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      if (manual_income == null || Number.isNaN(manual_income)) {
        return new Response(
          JSON.stringify({
            error:
              "manual_income is required for manually-reviewed applications",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      if (!manual_reason) {
        return new Response(
          JSON.stringify({
            error:
              "manual_reason is required for manually-reviewed applications",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    const newStatus = decision === "approve" ? "eligible" : "not_eligible";

    const updatePayload: Record<string, unknown> = {
      status: newStatus,
      decided_by: officer_id,
      decided_at: new Date().toISOString(),
    };
    if (app.source === "manual") {
      updatePayload.manual_gender = manual_gender;
      updatePayload.manual_income = manual_income;
      updatePayload.manual_reason = manual_reason;
    }

    const { data: updated, error: updateError } = await supabase
      .from("pink_card_applications")
      .update(updatePayload)
      .eq("id", application_id)
      .select()
      .single();

    if (updateError) throw updateError;

    return new Response(
      JSON.stringify({ success: true, application: updated }),
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

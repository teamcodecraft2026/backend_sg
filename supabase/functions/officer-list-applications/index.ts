// supabase/functions/officer-list-applications/index.ts
//
// Officer/admin-facing. Lists Pink Card applications for the Service Portal.
//
// GET /officer-list-applications?status=pending|checked
//   status=pending -> status = 'submitted'
//   status=checked -> status in ('eligible', 'not_eligible')
//   (omit status to get everything)
//
// Deploy: supabase functions deploy officer-list-applications

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
    const user_id = payload.sub as string;

    const { data: caller, error: callerError } = await supabase
      .from("users")
      .select("role")
      .eq("id", user_id)
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

    // ---- Build query ----
    const url = new URL(req.url);
    const statusFilter = url.searchParams.get("status"); // "pending" | "checked" | null

    let query = supabase
      .from("pink_card_applications")
      .select("*")
      .order("checked_at", { ascending: false });

    if (statusFilter === "pending") {
      query = query.eq("status", "submitted");
    } else if (statusFilter === "checked") {
      query = query.in("status", ["eligible", "not_eligible"]);
    }

    const { data: applications, error } = await query;
    if (error) throw error;

    return new Response(
      JSON.stringify({
        success: true,
        count: applications.length,
        applications,
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

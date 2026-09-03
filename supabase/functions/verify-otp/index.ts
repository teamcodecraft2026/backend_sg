import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

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
  ["sign"],
);

// 1. Define CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // 2. Handle the preflight request for CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { phone, otp_code } = await req.json();

    if (!phone || !otp_code) {
      return new Response(
        JSON.stringify({ error: "phone and otp_code are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: otpRow, error: otpError } = await supabase
      .from("otp_verifications")
      .select("*")
      .eq("phone", phone)
      .eq("verified", false)
      .gte("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (otpError || !otpRow) {
      return new Response(
        JSON.stringify({ error: "OTP expired or not found" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (otpRow.attempts >= 5) {
      return new Response(
        JSON.stringify({
          error: "Too many incorrect attempts. Request a new OTP.",
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (otpRow.otp_code !== otp_code) {
      await supabase
        .from("otp_verifications")
        .update({ attempts: otpRow.attempts + 1 })
        .eq("id", otpRow.id);
      return new Response(JSON.stringify({ error: "Invalid OTP" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // mark OTP as used
    await supabase
      .from("otp_verifications")
      .update({ verified: true })
      .eq("id", otpRow.id);

    // find or create user
    let { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("phone", phone)
      .single();

    if (!user) {
      const { data: newUser, error: insertError } = await supabase
        .from("users")
        .insert({ phone, role: "passenger" })
        .select()
        .single();
      if (insertError) throw insertError;
      user = newUser;
    }

    // issue JWT session token
    const token = await create(
      { alg: "HS256", typ: "JWT" },
      {
        sub: user.id,
        phone: user.phone,
        role: user.role,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
      },
      cryptoKey,
    );

    return new Response(JSON.stringify({ success: true, token, user }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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

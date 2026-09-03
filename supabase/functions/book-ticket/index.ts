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
    // ---- 1. Auth ----
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

    // ---- 2. Get trip_id from request ----
    const { trip_id } = await req.json();

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!trip_id || !uuidPattern.test(trip_id)) {
      return new Response(JSON.stringify({ error: "Invalid trip_id format" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- 3. Look up trip + route for fare ----
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("id, status, route_id, routes(base_fare, route_name)")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      return new Response(JSON.stringify({ error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (trip.status !== "scheduled" && trip.status !== "in_progress") {
      return new Response(
        JSON.stringify({ error: "This trip is not available for booking" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const base_fare = (trip.routes as any).base_fare;

    // ---- 4. Check latest Pink Card eligibility for this user ----
    const { data: latestApp } = await supabase
      .from("pink_card_applications")
      .select("eligible")
      .eq("user_id", user_id)
      .order("checked_at", { ascending: false })
      .limit(1)
      .single();

    const isEligible = latestApp?.eligible === true;
    const fare_charged = isEligible ? 0 : base_fare;

    // ---- 5. MOCKED PAYMENT STEP ----
    // In production this would call Razorpay/PhonePe and wait for a webhook.
    // For demo: payment always simulated as instant success.
    const payment_status = "success";

    // ---- 6. Create the ticket ----
    const ticket_id = crypto.randomUUID();

    const { data: ticket, error: insertError } = await supabase
      .from("tickets")
      .insert({
        id: ticket_id,
        user_id,
        trip_id,
        fare_charged,
        qr_payload: ticket_id, // QR encodes ticket ID only; scanner looks up the rest
        status: "issued",
      })
      .select()
      .single();

    if (insertError) throw insertError;

    return new Response(
      JSON.stringify({
        success: true,
        ticket,
        pink_card_applied: isEligible,
        payment_status,
        mock_payment: true,
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

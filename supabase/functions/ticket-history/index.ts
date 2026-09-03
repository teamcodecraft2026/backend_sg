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

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userToken = authHeader.replace("Bearer ", "");

    let payload;
    try {
      payload = await verify(userToken, cryptoKey);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid or expired session token" }),
        { status: 401 },
      );
    }

    const user_id = payload.sub as string;

    const { data: tickets, error } = await supabase
      .from("tickets")
      .select(
        "id, fare_charged, qr_payload, status, issued_at, scanned_at, trips(bus_number, departure_time, routes(route_name, origin, destination))",
      )
      .eq("user_id", user_id)
      .order("issued_at", { ascending: false });

    if (error) throw error;

    const formatted = (tickets ?? []).map((t: any) => ({
      ticket_id: t.id,
      route_name: t.trips?.routes?.route_name,
      origin: t.trips?.routes?.origin,
      destination: t.trips?.routes?.destination,
      bus_number: t.trips?.bus_number,
      departure_time: t.trips?.departure_time,
      fare_charged: t.fare_charged,
      status: t.status,
      issued_at: t.issued_at,
      scanned_at: t.scanned_at,
    }));

    return new Response(
      JSON.stringify({
        success: true,
        count: formatted.length,
        tickets: formatted,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "Something went wrong. Please try again." }),
      { status: 500 },
    );
  }
});

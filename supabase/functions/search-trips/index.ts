import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
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
    const url = new URL(req.url);
    const origin = url.searchParams.get("origin");
    const destination = url.searchParams.get("destination");

    let query = supabase
      .from("trips")
      .select(
        "id, bus_number, departure_time, status, routes(id, route_name, origin, destination, base_fare)",
      )
      .eq("status", "scheduled")
      .order("departure_time", { ascending: true });

    const { data: trips, error } = await query;
    if (error) throw error;

    // Filter by origin/destination on the joined route data (case-insensitive partial match)
    let results = trips ?? [];
    if (origin) {
      results = results.filter((t: any) =>
        t.routes?.origin?.toLowerCase().includes(origin.toLowerCase()),
      );
    }
    if (destination) {
      results = results.filter((t: any) =>
        t.routes?.destination
          ?.toLowerCase()
          .includes(destination.toLowerCase()),
      );
    }

    const formatted = results.map((t: any) => ({
      trip_id: t.id,
      bus_number: t.bus_number,
      departure_time: t.departure_time,
      route_name: t.routes?.route_name,
      origin: t.routes?.origin,
      destination: t.routes?.destination,
      base_fare: t.routes?.base_fare,
    }));

    return new Response(
      JSON.stringify({
        success: true,
        count: formatted.length,
        trips: formatted,
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

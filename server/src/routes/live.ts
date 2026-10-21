import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { cached } from "../cache.js";
import { sanitizeArtworkUrl } from "../artwork.js";
import { getShortEpg, listLiveCategories, listLiveStreams } from "../clients/xtream.js";

export async function liveRoutes(app: FastifyInstance) {
  app.get("/api/live/channels", async () => {
    const [categories, streams] = await cached("live:channels", config.cacheTtlSeconds, () =>
      Promise.all([listLiveCategories(), listLiveStreams()]),
    );

    const categoryNames = new Map(categories.map((c) => [c.category_id, c.category_name]));

    const channels = streams.map((s) => ({
      id: s.stream_id,
      name: s.name,
      icon: sanitizeArtworkUrl(s.stream_icon),
      category: categoryNames.get(s.category_id) ?? "Uncategorized",
    }));

    return { categories: categories.map((c) => c.category_name), channels };
  });

  app.get("/api/live/epg", async (request, reply) => {
    const { streamId } = request.query as { streamId?: string };
    if (!streamId) {
      return reply.code(400).send({ error: "streamId query param is required" });
    }
    const id = Number(streamId);
    const listings = await cached(`live:epg:${id}`, config.cacheTtlSeconds, () => getShortEpg(id));
    return { listings };
  });
}

import type { FastifyInstance } from "fastify";
import {
  configuredLibrarySources,
  getOwnedPopularLibrary,
  searchOwnedLibrary,
} from "../library.js";
import { mergeLibraries, titleContains } from "../merge.js";
import {
  getSeriesDetail,
  listXtreamByCategory,
  listXtreamCategoryRefs,
  parseXtreamSeriesId,
} from "../clients/xtream.js";

const CATEGORY_LIMIT = 400;
const SEARCH_LIMIT = 200;

export async function onDemandRoutes(app: FastifyInstance) {
  app.get("/api/ondemand/categories", async () => {
    return listXtreamCategoryRefs();
  });

  app.get("/api/ondemand/series/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const seriesId = parseXtreamSeriesId(`series:${id}`) ?? Number(id);
    if (!Number.isInteger(seriesId) || seriesId <= 0) {
      return reply.code(400).send({ error: "Invalid series id" });
    }
    return getSeriesDetail(seriesId);
  });

  app.get("/api/ondemand", async (request) => {
    const { search, source, type, category } = request.query as {
      search?: string;
      source?: string;
      type?: string;
      category?: string;
    };
    const kind = type === "movie" || type === "show" ? type : undefined;
    const sources = configuredLibrarySources();

    // A category is an Xtream browse (movies or series). Plex/Silo have no category ids,
    // so this path is the provider catalog filtered down to one folder.
    if (category && kind) {
      const xtreamItems = sources.xtream ? await listXtreamByCategory(kind, category) : [];
      const filtered = search ? xtreamItems.filter((item) => titleContains(item.title, search)) : xtreamItems;
      const truncated = filtered.length > CATEGORY_LIMIT;
      return {
        items: mergeLibraries([], [], filtered.slice(0, CATEGORY_LIMIT)),
        sources,
        truncated,
      };
    }

    // A real search goes straight to each library's own title lookup. Plex and Silo are
    // targeted indexed queries; Xtream filters its cached catalog (the panel has no
    // search action). The no-search page stays the small cached sample.
    const { merged } = search ? await searchOwnedLibrary(search) : await getOwnedPopularLibrary();

    let items = merged;
    if (source && source !== "all") {
      items = items.filter((item) => item.sources.some((entry) => entry.source === source));
    }
    if (kind) {
      items = items.filter((item) => item.type === kind);
    }

    const truncated = Boolean(search) && items.length > SEARCH_LIMIT;
    if (truncated) items = items.slice(0, SEARCH_LIMIT);

    return { items, sources, truncated };
  });
}

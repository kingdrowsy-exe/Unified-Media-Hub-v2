import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import Fastify from "fastify";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "umh-xtream-"));
process.env.DATA_DIR = dataDir;
fs.writeFileSync(
  path.join(dataDir, "settings.json"),
  JSON.stringify({
    xtream: {
      baseUrl: "http://iptv.example:8080",
      username: "user",
      password: "secret",
    },
  }),
);

const PROVIDER = "http://iptv.example:8080";

const vodStreams = [
  {
    stream_id: 5,
    name: "Dune (2021) [1080p]",
    stream_icon: "http://img.example/dune.jpg",
    category_id: "3",
    container_extension: "mp4",
    rating: "8.0",
    added: "200",
    direct_source: "http://evil.example/dune.mp4",
  },
  {
    stream_id: 6,
    name: "The.Matrix.1999.1080p.BluRay",
    category_id: 4,
    container_extension: "mkv",
    rating_5based: 4.5,
    added: "100",
  },
  {
    stream_id: 8,
    name: "Blade Runner 2049",
    category_id: "3",
    container_extension: "mkv",
    added: "50",
  },
];

const vodCategories = [
  { category_id: "3", category_name: "Action" },
  { category_id: "4", category_name: "Classics" },
];

const seriesList = [
  {
    series_id: 7,
    name: "The Expanse",
    cover: "http://img.example/expanse.jpg",
    category_id: "9",
    genre: "Drama / Sci-Fi",
    releaseDate: "2015-12-14",
    rating: "8.5",
    last_modified: "300",
  },
];

const seriesCategories = [{ category_id: "9", category_name: "Sci-Fi" }];

const seriesInfo = {
  info: {
    name: "The Expanse",
    cover: "http://img.example/expanse.jpg",
    plot: "A crew in the Belt.",
    releaseDate: "2015-12-14",
    genre: "Drama",
  },
  seasons: [{ season_number: 1, name: "Season 1", episode_count: 2, cover: "http://img.example/s1.jpg" }],
  episodes: {
    "1": [
      {
        id: "9",
        episode_num: "1",
        title: "Dulcinea",
        container_extension: "mkv",
        season: 1,
        info: { plot: "Ice hauler.", duration_secs: 2700, movie_image: "http://img.example/ep.jpg" },
      },
      {
        id: 10,
        episode_num: 2,
        title: "The Big Empty",
        container_extension: "mp4",
        season: 1,
        info: { duration: "00:42:00" },
      },
    ],
  },
};

const vodInfo = {
  info: {
    plot: "Spice.",
    genre: "Science Fiction",
    releasedate: "2021-10-22",
    duration_secs: 9360,
    video: { height: 1080, codec_name: "h264" },
    audio: { codec_name: "aac" },
  },
  movie_data: { stream_id: 5, name: "Dune (2021) [1080p]", container_extension: "mp4" },
};

type FetchCall = { url: string; range?: string };

const calls: FetchCall[] = [];
const originalFetch = globalThis.fetch;

function headerRange(headers: HeadersInit | undefined): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get("range") ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === "range");
    return found?.[1];
  }
  const record = headers as Record<string, string>;
  return record.range ?? record.Range;
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  calls.push({ url, range: headerRange(init?.headers) });
  const parsed = new URL(url);
  if (parsed.hostname !== "iptv.example") {
    return new Response("unexpected host", { status: 500 });
  }

  if (parsed.pathname.endsWith("/player_api.php")) {
    const action = parsed.searchParams.get("action");
    if (action === "get_vod_streams") return Response.json(vodStreams);
    if (action === "get_vod_categories") return Response.json(vodCategories);
    if (action === "get_series") return Response.json(seriesList);
    if (action === "get_series_categories") return Response.json(seriesCategories);
    if (action === "get_series_info") return Response.json(seriesInfo);
    if (action === "get_vod_info") return Response.json(vodInfo);
    return Response.json([]);
  }

  if (parsed.pathname.endsWith(".mp4")) {
    const ranged = Boolean(headerRange(init?.headers));
    return new Response("video-bytes", {
      status: ranged ? 206 : 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": "11",
        ...(ranged ? { "content-range": "bytes 0-10/11" } : {}),
      },
    });
  }

  if (parsed.pathname.endsWith(".m3u8")) {
    return new Response("#EXTM3U\nseg.ts\n", {
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" },
    });
  }

  return new Response("missing", { status: 404 });
};

describe("xtream vod and series", { concurrency: 1 }, () => {
  let app: ReturnType<typeof Fastify>;
  let bustCache: (prefix: string) => void;
  let cleanXtreamTitle: (raw: string) => { title: string; year?: number };
  let mapSeriesPayload: (seriesId: number, payload: unknown) => {
    episodes: { id: string; playback: string; season: number; episode: number }[];
    seasons: { number: number; episodeCount: number }[];
  };
  let mergeLibraries: (
    plex: { ratingKey: string; title: string; year?: number; type: string; thumb?: string }[],
    silo: { Id: string; Name: string; ProductionYear?: number; Type: string }[],
    xtream: { id: string; title: string; year?: number; type: "movie" | "show" }[],
  ) => { title: string; year?: number; type: string; sources: { source: string; id: string }[] }[];
  let pickBestMatch: <T extends { title: string; year?: number; type?: "movie" | "show" }>(
    items: T[],
    title: string,
    year?: number,
    type?: "movie" | "show",
  ) => T | undefined;
  let xtreamPlaybackTarget: (kind: "vod" | "episode", id: number, extension: string) => { url: string; hls: boolean };

  before(async () => {
    const cache = await import("../src/cache.js");
    const xtream = await import("../src/clients/xtream.js");
    const merge = await import("../src/merge.js");
    const ondemand = await import("../src/routes/ondemand.js");
    const stream = await import("../src/routes/stream.js");
    const details = await import("../src/routes/details.js");
    const popular = await import("../src/routes/popular.js");
    bustCache = cache.bustCache;
    cleanXtreamTitle = xtream.cleanXtreamTitle;
    mapSeriesPayload = xtream.mapSeriesPayload;
    mergeLibraries = merge.mergeLibraries;
    pickBestMatch = merge.pickBestMatch;
    xtreamPlaybackTarget = xtream.xtreamPlaybackTarget;

    app = Fastify({ logger: false });
    await app.register(ondemand.onDemandRoutes);
    await app.register(stream.streamRoutes);
    await app.register(details.detailsRoutes);
    await app.register(popular.popularRoutes);
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  test("cleans release names without eating a title that ends in a number", () => {
    assert.deepEqual(cleanXtreamTitle("Dune (2021) [1080p]"), { title: "Dune", year: 2021 });
    assert.deepEqual(cleanXtreamTitle("The.Matrix.1999.1080p.BluRay"), { title: "The Matrix", year: 1999 });
    assert.deepEqual(cleanXtreamTitle("Blade Runner 2049"), { title: "Blade Runner 2049", year: undefined });
  });

  test("dedups an Xtream movie with Plex and keeps a show separate", () => {
    const merged = mergeLibraries(
      [{ ratingKey: "11", title: "Dune", year: 2021, type: "movie" }],
      [],
      [
        { id: "vod:5:mp4", title: "Dune", year: 2021, type: "movie" },
        { id: "series:7", title: "Dune", year: 2021, type: "show" },
      ],
    );
    const movie = merged.find((item) => item.type === "movie" && item.title === "Dune");
    const show = merged.find((item) => item.type === "show");
    assert.ok(movie);
    assert.deepEqual(
      movie.sources.map((source) => source.source).sort(),
      ["plex", "xtream"],
    );
    assert.equal(movie.sources.find((source) => source.source === "xtream")?.id, "vod:5:mp4");
    assert.equal(show?.sources[0]?.id, "series:7");

    const undated = mergeLibraries(
      [{ ratingKey: "11", title: "Dune", year: 2021, type: "movie" }],
      [],
      [{ id: "vod:5:mp4", title: "Dune", type: "movie" }],
    );
    assert.equal(undated.length, 1);
    assert.equal(undated[0]?.year, 2021);
    const best = pickBestMatch(undated, "Dune", 2021, "movie");
    assert.equal(best?.sources.some((source) => source.source === "xtream"), true);
  });

  test("maps seasons from either an episode object or a flat list", () => {
    const fromObject = mapSeriesPayload(7, seriesInfo);
    assert.equal(fromObject.seasons.length, 1);
    assert.equal(fromObject.seasons[0]?.episodeCount, 2);
    assert.deepEqual(
      fromObject.episodes.map((episode) => [episode.id, episode.playback, episode.episode]),
      [
        ["episode:9:mkv", "hls", 1],
        ["episode:10:mp4", "file", 2],
      ],
    );

    const fromArray = mapSeriesPayload(7, {
      info: { name: "Odd" },
      episodes: [{ stream_id: "4", episode_num: 3, title: "Special", season: 0 }],
    });
    assert.equal(fromArray.episodes[0]?.id, "episode:4:mkv");
    assert.equal(fromArray.episodes[0]?.season, 0);
    assert.equal(fromArray.episodes[0]?.playback, "hls");
  });

  test("playback URLs stay on the configured provider host", () => {
    const movie = xtreamPlaybackTarget("vod", 5, "mp4");
    const episode = xtreamPlaybackTarget("episode", 9, "mkv");
    assert.equal(movie.hls, false);
    assert.equal(movie.url, `${PROVIDER}/movie/user/secret/5.mp4`);
    assert.equal(episode.hls, true);
    assert.equal(episode.url, `${PROVIDER}/series/user/secret/9.m3u8`);
    for (const target of [movie.url, episode.url]) {
      const parsed = new URL(target);
      assert.equal(parsed.host, "iptv.example:8080");
    }
  });

  test("browse, category, and search return xtream movies and series", async () => {
    bustCache("ondemand:");
    bustCache("xtream:");

    const browse = await app.inject({ method: "GET", url: "/api/ondemand" });
    assert.equal(browse.statusCode, 200);
    const browseBody = browse.json();
    assert.equal(browseBody.sources.xtream, true);
    assert.equal(browseBody.sources.plex, false);
    const titles = browseBody.items.map((item: { title: string }) => item.title);
    assert.deepEqual(titles, ["Blade Runner 2049", "Dune", "The Expanse", "The Matrix"]);
    const dune = browseBody.items.find((item: { title: string }) => item.title === "Dune");
    assert.equal(dune.year, 2021);
    assert.equal(dune.type, "movie");
    assert.equal(dune.genre, "Action");
    assert.equal(dune.sources[0].id, "vod:5:mp4");
    const expanse = browseBody.items.find((item: { title: string }) => item.title === "The Expanse");
    assert.equal(expanse.year, 2015);
    assert.equal(expanse.type, "show");
    assert.equal(expanse.sources[0].id, "series:7");
    const matrix = browseBody.items.find((item: { title: string }) => item.title === "The Matrix");
    assert.equal(matrix.year, 1999);
    assert.equal(matrix.ratingPercent, 90);
    const blade = browseBody.items.find((item: { title: string }) => item.title === "Blade Runner 2049");
    assert.equal(blade.year, undefined);

    const category = await app.inject({ method: "GET", url: "/api/ondemand?type=movie&category=3" });
    const categoryTitles = category.json().items.map((item: { title: string }) => item.title).sort();
    assert.deepEqual(categoryTitles, ["Blade Runner 2049", "Dune"]);

    const search = await app.inject({ method: "GET", url: "/api/ondemand?search=expanse" });
    assert.deepEqual(
      search.json().items.map((item: { title: string }) => item.title),
      ["The Expanse"],
    );

    const categories = await app.inject({ method: "GET", url: "/api/ondemand/categories" });
    assert.deepEqual(categories.json(), {
      vod: [
        { id: "3", name: "Action" },
        { id: "4", name: "Classics" },
      ],
      series: [{ id: "9", name: "Sci-Fi" }],
    });
  });

  test("series detail lists seasons and episode playback ids", async () => {
    bustCache("xtream:");
    const res = await app.inject({ method: "GET", url: "/api/ondemand/series/7" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.plot, "A crew in the Belt.");
    assert.equal(body.seasons[0].episodeCount, 2);
    assert.equal(body.episodes[0].id, "episode:9:mkv");
    assert.equal(body.episodes[0].playback, "hls");
    assert.equal(body.episodes[0].durationSecs, 2700);
    assert.equal(body.episodes[1].id, "episode:10:mp4");
    assert.equal(body.episodes[1].playback, "file");
    assert.equal(body.episodes[1].durationSecs, 42 * 60);
  });

  test("movie sources are playable and series are not flattened into versions", async () => {
    bustCache("xtream:");
    const movie = await app.inject({
      method: "GET",
      url: "/api/sources?title=Dune&year=2021&type=movie",
    });
    const versions = movie.json().versions;
    assert.equal(versions.length, 1);
    assert.equal(versions[0].source, "xtream");
    assert.equal(versions[0].id, "vod:5:mp4");
    assert.equal(versions[0].serverName, "Xtream");
    assert.equal(versions[0].playback, "file");
    assert.equal(versions[0].resolution, "1080p");
    assert.ok(versions[0].badges.includes("1080p"));
    assert.ok(versions[0].badges.includes("H264"));

    const show = await app.inject({
      method: "GET",
      url: "/api/sources?title=The%20Expanse&year=2015&type=show",
    });
    assert.deepEqual(show.json().versions, []);

    const match = await app.inject({
      method: "GET",
      url: "/api/match?title=The%20Expanse&year=2015&type=show",
    });
    assert.deepEqual(match.json().sources, [{ source: "xtream", id: "series:7" }]);
  });

  test("mp4 vod is proxied from the provider host and mkv episodes are requested as hls", async () => {
    calls.length = 0;
    const file = await app.inject({
      method: "GET",
      url: `/api/stream/xtream/${encodeURIComponent("vod:5:mp4")}`,
      headers: { range: "bytes=0-" },
    });
    assert.equal(file.statusCode, 206);
    assert.equal(file.body, "video-bytes");
    assert.equal(file.headers["content-type"], "video/mp4");
    assert.equal(file.headers["content-range"], "bytes 0-10/11");
    const movieCall = calls.find((call) => call.url.includes("/movie/"));
    assert.ok(movieCall);
    assert.equal(movieCall.url, `${PROVIDER}/movie/user/secret/5.mp4`);
    assert.equal(movieCall.range, "bytes=0-");
    assert.equal(calls.some((call) => call.url.includes("evil.example")), false);

    calls.length = 0;
    const hls = await app.inject({
      method: "GET",
      url: `/api/stream/xtream/${encodeURIComponent("episode:9:mkv")}`,
    });
    assert.equal(hls.statusCode, 200);
    assert.match(hls.headers["content-type"] ?? "", /mpegurl/);
    const episodeCall = calls.find((call) => call.url.includes("/series/"));
    assert.ok(episodeCall);
    const episodeUrl = new URL(episodeCall.url);
    assert.equal(episodeUrl.host, "iptv.example:8080");
    assert.equal(episodeUrl.pathname, "/series/user/secret/9.m3u8");
    const rewritten = decodeURIComponent(hls.body);
    assert.match(rewritten, /\/api\/hls\?u=/);
    assert.match(rewritten, /http:\/\/iptv\.example:8080\/series\/user\/secret\/seg\.ts/);
    assert.equal(calls.some((call) => call.url.includes("evil.example")), false);

    const invalid = await app.inject({ method: "GET", url: "/api/stream/xtream/nope" });
    assert.equal(invalid.statusCode, 400);
  });
});

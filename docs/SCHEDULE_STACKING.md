# Automatic stacking by guide schedule

Regular IPTV feeds within one source can share a viewer channel row even when their station names and mapped XMLTV IDs differ. Existing station-name stacking still applies. The source's Channels settings table reports the effective stack on each individual feed.

Schedule matching requires at least three consecutive real programs and at least two distinct title/subtitle combinations. Every available listing in the current/upcoming 48-hour window must match in start time, end time, title and subtitle. Titles and subtitles ignore case, Unicode presentation differences and whitespace; descriptions and EPG channel IDs do not affect matching. Time shifts, later disagreements, differing coverage, expired guides, placeholders, overlapping listings and insufficient data do not establish a schedule match.

Whole station-name stacks move together, including backup feeds without their own guide mapping. A name stack with conflicting or incomplete mapped schedules cannot bridge other stations. Manual station assignments and **Keep as its own channel** take precedence. Event channels keep their existing event-based grouping, and feeds from different sources stay separate.

This is presentation grouping: each feed retains its identity, number, health, favorites and guide mapping. Existing feed ranking and health promotion still choose the default. Schedule grouping is recalculated when playlist, guide or manual guide mapping revisions change and at most once per minute otherwise. If refreshed schedules diverge or evidence expires, the feeds return to their name-based groups. No migration or source refresh is needed to use an already imported guide after the updated server is loaded.

Implementation: `services/schedule-stacks.ts` and `IptvStore.automaticStackKeys`. Focused coverage: `tests/schedule-stacks.test.ts`, alongside existing `tests/channel-stacks.test.ts`.

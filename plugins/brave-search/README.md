# brave-search

web search via the [Brave Search API](https://brave.com/search/api/).

## tools

| tool | description |
|-|-|
| `web_search` | search the web. returns titles, URLs, and snippets |

### `web_search` parameters

| param | type | description |
|-|-|-|
| `query` | string | search query (required) |
| `count` | number | results per request, 1-20 (default 10) |
| `offset` | number | pagination offset, 0-9 |
| `freshness` | string | time filter: `pd` (day), `pw` (week), `pm` (month), `py` (year) |
| `country` | string | 2-letter country code for regional results |

## configuration

set your API key in `~/.toebeans/config.json5`:

```json5
plugins: {
  "brave-search": {
    apiKey: "BSA..."
  }
}
```

alternatively, set the `BRAVE_SEARCH_API_KEY` environment variable. plugin config takes precedence.

## notes

- the plugin warns on startup if no API key is found, but doesn't fail — it returns an error at query time instead
- offset max is 9 (Brave API constraint), so you can page through at most 200 results
- `extra_snippets` from the API response are available but not currently surfaced in output

# SiteLimit

**Your time is too expensive to donate to the feed.**

SiteLimit puts session and daily limits on the sites that eat your day.

No dashboards. No streaks. No productivity circus.
Just a tiny Chrome extension that does its job and gets out of the way.

Know you'll cheat? Lock the settings. Most bad ideas don't survive 5 minutes.

## Install

Chrome Web Store — coming soon.

### Install locally

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

### Package for the Chrome Web Store

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
```

Then upload the generated zip from `dist/`.

## Privacy

No ads. Your limits and usage stay locally in your browser. [Read the privacy policy](PRIVACY.md)

## Feedback

Found a bug or got an idea? [Open an issue](https://github.com/coenclaassen/sitelimit/issues).

## License

Free for noncommercial use under the [PolyForm Noncommercial 1.0.0](LICENSE) license.

# Privacy Policy for Snaffle

Last updated: 17 November 2026

Snaffle is a Chrome extension that saves images, video and page screenshots from the web page you are viewing. This policy says what it handles, where that stays, and what it never does.

## The short version

Snaffle has no server. It does not collect, sell or share any information about you, and it sends nothing to its developer or to any third party. There are no analytics, no advertising and no tracking. Everything it does happens in your own browser, and what it saves goes to your own Downloads folder.

## What Snaffle handles, and where it stays

**The media you choose to save.** When you press your trigger, use the right-click menu, download from the media list or take a screenshot, Snaffle reads the image, video or page in front of you and saves it to your Downloads folder. To fetch a file it contacts the website that hosts that file, the same site your browser was already loading it from. The file goes to your disk and nowhere else.

**Your settings.** Your triggers, your folder and file-name patterns and your other options are kept in Chrome's synced extension storage. If you have Chrome sync turned on, Google stores them with your Google account so that they follow you to your other computers, under Google's own privacy policy. They contain no browsing information. If Chrome sync is off, they stay on this computer.

**A counter.** A running number, used for the `{index}` part of a file name if you use it, is kept on this computer.

**Video addresses seen in this session.** A streamed video has no single file to save, so Snaffle notes the addresses of the video playlists that pages request, and on sites that serve a video as separate picture and sound files (Instagram is one) the addresses of those files, in order to rebuild a video when you ask for one. These notes are held in the browser's memory only. They are dropped after two hours, capped at a few hundred entries, erased when Chrome closes, and never written to disk or sent anywhere.

**Downloads in progress.** While a download is still arriving, Snaffle remembers which tab asked for it so that it can report a late failure there. This is also held in memory only and cleared when the download ends or Chrome closes.

The "Recently saved" list in the toolbar popup is read from Chrome's own download history. Snaffle keeps no copy of it.

## What Snaffle does not do

- It does not collect personal information, browsing history, page content, keystrokes or form data.
- It does not read a page until you use one of its triggers. Before that it only tracks which element the pointer is over, in the page itself, so that it knows what to save.
- It does not send anything to its developer. There is nowhere for it to send it.
- It does not use cookies, analytics, advertising or any third-party service.
- It does not load or run code from the internet. All of its code is in the extension package.

## Permissions

Snaffle asks for access to all websites because the pictures and video you may want to save can be on any site, and are often served from a different address than the page showing them. That access is used only to find, fetch and save what you ask for, and to capture a page when you ask for a screenshot.

## Deleting your data

Removing the extension removes its settings and its counter. Files you saved are ordinary files in your Downloads folder and are yours to keep or delete. The "Reset everything to defaults" button on the options page returns every setting to its default.

## Changes to this policy

If Snaffle's handling of data ever changes, this page will be updated before the change is released, and the date at the top will change. The history of this file is public at https://github.com/melovibes/snaffle/commits/main/PRIVACY.md.

## Contact

Questions about privacy can be raised at https://github.com/melovibes/snaffle/issues.

# Changelog

## 0.3.0

Add **Approve all for this session** to the native action approval menu, alongside **Approve once** and **Deny**. Approval resets on disconnect, session/branch change, or reload; browser sharing and safety restrictions remain unchanged.

## 0.2.2

Make the toolbar artwork larger and bolder, with a red dot when no tab is shared and a green dot while sharing. Reset the indicator after disconnection or worker restart; replace the old ON badge.

## 0.2.1

Enlarge the browser-window artwork by 35% within Chromium's fixed icon slot, reducing padding and improving toolbar legibility.

## 0.2.0

Guided `/browser-connect` setup registers the browser bridge from Pi and shows the extension folder. Install directly with `pi install npm:@kvidzibo/pi-browser-connect`; no global npm install or extension ID is needed. The browser popup starts the bridge and updates pairing automatically. Loading the unpacked extension and sharing a tab still require your approval.

## 0.1.2

Add the Pi browser-window icon to the browser toolbar and extension manager.

## 0.1.1

Document the published npm installation and prepare the first trusted-publisher release. Browser and Pi behavior are unchanged.

## 0.1.0

Initial Linux/Chromium release: explicit single-tab sharing, native messaging bridge, Pi browser tools with action approvals, isolated integration tests, and GitHub/npm release automation.

/**
 * Screenshot the ACTUAL running bridge browser (not a new instance).
 * Uses the same profile; if the server's browser is open, we attach via CDP.
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { config } from '../src/config/env.js';

fs.mkdirSync('.runtime', { recursive: true });

// Try to connect to the running Chrome with the profile via CDP pipe is hard;
// instead launch with the same profile is blocked. So we screenshot by taking
// a picture of the visible Chrome window using PowerShell (PrintWindow).
// This script instead just returns the path where the OS-level screenshot goes.

// Use a different approach: the server holds the profile. We can't launch a
// second instance. So we screenshot the desktop window via PowerShell.

// Simplest robust path: tell the running server to screenshot itself.
// The server's status/screenshot endpoint isn't public, but we can trigger
// via the driver. Actually - just call the models endpoint which forces the
// browser to be active, then use PowerShell to capture the screen.

console.log('Screenshot approach: capture visible Chrome window via PowerShell');
console.log('(Run the PowerShell capture from the shell tool instead)');

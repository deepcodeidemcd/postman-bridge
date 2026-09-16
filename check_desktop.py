"""Check if Postman Desktop is running with CDP. The desktop app runs the Agent
Worker in a Node process that talks DIRECTLY to Postman's AI gateway - possibly
with different auth than the web. If it's running, attach and explore."""
import subprocess, json, urllib.request

# Check if Postman desktop is running
result = subprocess.run(
    ["powershell", "-Command",
     "Get-Process | Where-Object {$_.Name -like '*postman*'} | Select-Object Id, Name | Format-Table -AutoSize"],
    capture_output=True, text=True, timeout=30
)
print("Postman processes:")
print(result.stdout)

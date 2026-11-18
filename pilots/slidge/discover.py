"""Check the actual XMPP component over the offline Compose network."""

import asyncio
import os
import ssl
from importlib.metadata import version

from slixmpp import ClientXMPP


async def main():
    xmpp = ClientXMPP("test@localhost", "password")  # Upstream fixture account.
    xmpp.ssl_context = ssl.create_default_context(cafile=os.environ["PROSODY_CA"])
    xmpp.register_plugin("xep_0030")
    result = asyncio.get_running_loop().create_future()

    async def discover(_event):
        try:
            response = await xmpp.plugin["xep_0030"].get_info(jid="slidge.localhost", timeout=5)
            info = response["disco_info"]
            identities = list(info["identities"])
            if not any(kind == "gateway" and transport == "whatsapp" for kind, transport, *_ in identities):
                raise RuntimeError(f"Expected a WhatsApp gateway, got {identities!r}")
            result.set_result(identities)
        except Exception as exc:
            if not result.done():
                result.set_exception(exc)

    xmpp.add_event_handler("session_start", discover)
    try:
        await xmpp.connect(host="prosody", port=5222)
        identities = await asyncio.wait_for(result, timeout=12)
        print(f"Slidge-WhatsApp {version('slidge-whatsapp')}: authenticated XMPP discovery {identities!r}")
    finally:
        await xmpp.disconnect(wait=1)


if __name__ == "__main__":
    asyncio.run(main())

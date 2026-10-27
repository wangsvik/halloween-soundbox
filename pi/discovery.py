"""mDNS/zeroconf-annonsering slik at Homey-appen finner boksen automatisk."""

from __future__ import annotations

import logging
import socket

import ifaddr
from zeroconf import IPVersion, ServiceInfo
from zeroconf.asyncio import AsyncZeroconf

log = logging.getLogger("soundbox.discovery")

# Maks 15 tegn i tjenestenavnet (RFC 6335). Må matche Homey-appens app.json.
SERVICE_TYPE = "_hwsoundbox._tcp.local."


def _local_ipv4() -> list[str]:
    addresses = []
    for adapter in ifaddr.get_adapters():
        for ip in adapter.ips:
            if ip.is_IPv4 and not ip.ip.startswith("127.") and not ip.ip.startswith("169.254."):
                addresses.append(ip.ip)
    return addresses


class Announcer:
    def __init__(self, device_id: str, name: str, port: int, version: str):
        self.device_id = device_id
        self.name = name
        self.port = port
        self.version = version
        self._zc: AsyncZeroconf | None = None
        self._info: ServiceInfo | None = None

    async def start(self) -> None:
        addresses = _local_ipv4()
        if not addresses:
            log.warning("Fant ingen nettverksadresse; hopper over mDNS-annonsering")
            return
        self._info = ServiceInfo(
            SERVICE_TYPE,
            f"{self.name}.{SERVICE_TYPE}",
            addresses=[socket.inet_aton(a) for a in addresses],
            port=self.port,
            properties={"id": self.device_id, "name": self.name, "version": self.version},
            server=f"{socket.gethostname()}.local.",
        )
        self._zc = AsyncZeroconf(ip_version=IPVersion.V4Only)
        await self._zc.async_register_service(self._info, allow_name_change=True)
        log.info("Annonserer %s på %s:%s", SERVICE_TYPE, addresses, self.port)

    async def stop(self) -> None:
        if self._zc and self._info:
            await self._zc.async_unregister_service(self._info)
            await self._zc.async_close()

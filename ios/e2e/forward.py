# Forwards 127.0.0.1:<port> to blimpd's unix socket, as the SSH tunnel does on a Mac, for the app-e2e job
# (in place of socat, which took Homebrew up to 3 minutes to install).
#   python3 ios/e2e/forward.py <port> <socket>
import asyncio
import sys


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
    except OSError:
        pass


async def connection(client_reader, client_writer):
    try:
        reader, writer = await asyncio.open_unix_connection(sys.argv[2])
    except OSError:
        # blimpd is down (the test restarts it): the app sees the connection drop, as through a tunnel
        client_writer.close()
        return
    await asyncio.gather(pipe(client_reader, writer), pipe(reader, client_writer))
    writer.close()
    client_writer.close()


async def main():
    server = await asyncio.start_server(connection, "127.0.0.1", int(sys.argv[1]), reuse_address=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())

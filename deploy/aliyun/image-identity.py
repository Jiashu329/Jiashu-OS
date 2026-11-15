#!/usr/bin/env python3
"""Verify one transported image across classic and containerd Docker stores."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import tarfile

DIGEST = re.compile(r"sha256:[a-f0-9]{64}\Z")


def require(value, message):
    if not value:
        raise ValueError(message)


def normalized(value):
    # Docker inspect may add empty/default top-level Config fields. Preserve
    # nested maps verbatim: empty objects carry ExposedPorts/Volumes keys, and
    # empty strings in labels remain meaningful. Numeric zero is not False.
    return {key: item for key, item in value.items()
            if item is not None and item is not False and item != "" and item != [] and item != {}}


def archive_identity(path, commit, source_id):
    expected_tag = "jiashu-test:" + commit
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        files = {member.name: member for member in members}
        require(len(files) == len(members), "Duplicate archive paths")

        def read(name):
            member = files.get(name)
            require(member is not None and member.isfile() and member.size <= 2 * 1024 * 1024, "Invalid image metadata member")
            return archive.extractfile(member).read()

        manifest = json.loads(read("manifest.json"))
        require(isinstance(manifest, list) and len(manifest) == 1, "Archive must contain one image")
        image = manifest[0]
        require(isinstance(image, dict) and image.get("RepoTags") == [expected_tag], "Archive tag does not match the exact commit")
        require(isinstance(image.get("Config"), str), "Missing image configuration")
        layers = image.get("Layers")
        require(isinstance(layers, list) and len(layers) > 0 and len(set(layers)) == len(layers), "Invalid image layers")
        require(all(isinstance(name, str) and name in files and files[name].isfile() for name in layers), "Missing image layer")
        raw_config = read(image["Config"])
        config_digest = "sha256:" + hashlib.sha256(raw_config).hexdigest()
        config = json.loads(raw_config)
        require(config.get("os") == "linux" and config.get("architecture") == "amd64", "Unsupported image platform")
        require(isinstance(config.get("config"), dict) and config["config"].get("Labels", {}).get("org.opencontainers.image.revision") == commit, "Archive revision does not match commit")
        rootfs = config.get("rootfs", {})
        require(rootfs.get("type") == "layers" and isinstance(rootfs.get("diff_ids"), list) and len(rootfs["diff_ids"]) == len(layers) and all(isinstance(value, str) and DIGEST.fullmatch(value) for value in rootfs["diff_ids"]), "Invalid image root filesystem")
        # Docker's classic store identifies an image by config digest. Its new
        # containerd store identifies the same image by manifest/index digest.
        # Accept only content-addressed OCI documents that reference this config.
        candidates = {config_digest}
        indexes = []
        for name, member in files.items():
            if not re.fullmatch(r"blobs/sha256/[a-f0-9]{64}", name) or not member.isfile() or member.size > 2 * 1024 * 1024:
                continue
            raw = read(name)
            digest = "sha256:" + hashlib.sha256(raw).hexdigest()
            require(digest == "sha256:" + name.rsplit("/", 1)[1], "OCI metadata content digest mismatch")
            try:
                document = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                continue
            if not isinstance(document, dict):
                continue
            if isinstance(document.get("config"), dict) and document["config"].get("digest") == config_digest:
                candidates.add(digest)
            elif isinstance(document.get("manifests"), list):
                indexes.append((digest, document["manifests"]))
        if "index.json" in files:
            raw = read("index.json")
            document = json.loads(raw)
            require(isinstance(document, dict) and isinstance(document.get("manifests"), list), "Invalid OCI index")
            indexes.append(("sha256:" + hashlib.sha256(raw).hexdigest(), document["manifests"]))
        for _ in range(len(indexes) + 1):
            for digest, descriptors in indexes:
                if descriptors and all(isinstance(item, dict) and item.get("digest") in candidates for item in descriptors):
                    candidates.add(digest)
        require(source_id in candidates, "Source image identity is not represented by the verified archive")
        return expected_tag, config


def verify_loaded(value, expected_config, commit):
    require(isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict), "Loaded image inspect shape is invalid")
    loaded = value[0]
    require(isinstance(loaded.get("Id"), str) and DIGEST.fullmatch(loaded["Id"]), "Loaded image ID is not immutable")
    require(loaded.get("Os") == expected_config["os"] and loaded.get("Architecture") == expected_config["architecture"], "Loaded image platform differs from archive")
    require(loaded.get("Variant", "") == expected_config.get("variant", ""), "Loaded image variant differs from archive")
    require(isinstance(loaded.get("Config"), dict) and normalized(loaded["Config"]) == normalized(expected_config["config"]), "Loaded image configuration differs from archive")
    require(loaded["Config"].get("Labels", {}).get("org.opencontainers.image.revision") == commit, "Loaded image revision differs from commit")
    rootfs = loaded.get("RootFS", {})
    require(rootfs.get("Type") == "layers" and rootfs.get("Layers") == expected_config["rootfs"]["diff_ids"], "Loaded image filesystem differs from archive")
    return loaded["Id"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--source-id", required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{40}", args.commit) and DIGEST.fullmatch(args.source_id), "Invalid source identity")
    tag, config = archive_identity(args.archive, args.commit, args.source_id)
    subprocess.run(["docker", "image", "load", "--input", args.archive], check=True, stdout=subprocess.DEVNULL)
    loaded = subprocess.run(["docker", "image", "inspect", tag], check=True, stdout=subprocess.PIPE, encoding="utf-8")
    print(verify_loaded(json.loads(loaded.stdout), config, args.commit))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError) as error:
        # Metadata may contain environment values; never print it or Docker's
        # captured inspect output, even when verification fails.
        print("Image transport identity verification failed: " + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)

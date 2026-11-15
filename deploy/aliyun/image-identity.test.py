#!/usr/bin/env python3
"""Image transport fixtures: no daemon, HTTP server or remote access required."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("image_identity", Path(__file__).with_name("image-identity.py"))
IDENTITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IDENTITY)
COMMIT = "a" * 40
TAG = "jiashu-test:" + COMMIT
LOCAL_ID = "sha256:" + "b" * 64
LAYER = b"portable filesystem fixture"


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


class ImageIdentityTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="jiashu-image-identity-")
        self.addCleanup(self.directory.cleanup)
        self.config = {
            "os": "linux", "architecture": "amd64",
            "config": {"User": "10001", "WorkingDir": "/app", "Entrypoint": ["sh", "selfhost/entrypoint.sh"],
                       "Env": ["NODE_ENV=production"], "Labels": {"org.opencontainers.image.revision": COMMIT}},
            "rootfs": {"type": "layers", "diff_ids": [digest(LAYER)]},
        }

    def archive(self, config=None, tags=None, count=1, oci=False, duplicate=False):
        config = copy.deepcopy(self.config if config is None else config)
        raw_config = encoded(config)
        config_id = digest(raw_config)
        config_path = config_id[7:] + ".json"
        entries = {config_path: raw_config, "layer/layer.tar": LAYER}
        manifest = {"Config": config_path, "RepoTags": [TAG] if tags is None else tags, "Layers": ["layer/layer.tar"]}
        entries["manifest.json"] = encoded([manifest] * count)
        source_id = config_id
        if oci:
            raw_manifest = encoded({"schemaVersion": 2,
                "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config_id, "size": len(raw_config)},
                "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar", "digest": digest(LAYER), "size": len(LAYER)}]})
            source_id = digest(raw_manifest)
            entries["blobs/sha256/" + source_id[7:]] = raw_manifest
            entries["index.json"] = encoded({"schemaVersion": 2, "manifests": [{"digest": source_id}]})
        path = Path(self.directory.name, "image.tar.gz")
        with tarfile.open(path, "w:gz") as archive:
            for name, payload in entries.items():
                member = tarfile.TarInfo(name)
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
            if duplicate:
                member = tarfile.TarInfo("manifest.json")
                member.size = len(entries["manifest.json"])
                archive.addfile(member, io.BytesIO(entries["manifest.json"]))
        return path, source_id, config

    def loaded(self, config=None):
        config = self.config if config is None else config
        return [{"Id": LOCAL_ID, "Os": config["os"], "Architecture": config["architecture"],
                 "Config": copy.deepcopy(config["config"]),
                 "RootFS": {"Type": "layers", "Layers": copy.deepcopy(config["rootfs"]["diff_ids"])}}]

    def test_classic_archive_identifies_exact_single_commit_image(self):
        path, source_id, config = self.archive()
        self.assertEqual(IDENTITY.archive_identity(path, COMMIT, source_id), (TAG, config))

    def test_oci_manifest_and_index_identities_are_content_addressed(self):
        path, manifest_id, config = self.archive(oci=True)
        self.assertEqual(IDENTITY.archive_identity(path, COMMIT, manifest_id), (TAG, config))
        with tarfile.open(path, "r:gz") as archive:
            index_id = digest(archive.extractfile("index.json").read())
        self.assertEqual(IDENTITY.archive_identity(path, COMMIT, index_id), (TAG, config))

    def test_destination_store_can_have_a_different_immutable_id(self):
        path, source_id, config = self.archive()
        self.assertNotEqual(source_id, LOCAL_ID)
        _, verified = IDENTITY.archive_identity(path, COMMIT, source_id)
        self.assertEqual(IDENTITY.verify_loaded(self.loaded(config), verified, COMMIT), LOCAL_ID)

    def test_loaded_config_defaults_do_not_hide_meaningful_changes(self):
        loaded = self.loaded()
        loaded[0]["Config"]["AttachStdin"] = False
        loaded[0]["Config"]["Cmd"] = None
        self.assertEqual(IDENTITY.verify_loaded(loaded, self.config, COMMIT), LOCAL_ID)
        loaded[0]["Config"]["Cmd"] = ["changed"]
        with self.assertRaises(ValueError):
            IDENTITY.verify_loaded(loaded, self.config, COMMIT)

    def test_nested_port_volume_and_empty_label_entries_are_preserved(self):
        for field, original, changed in [
            ("ExposedPorts", {"3000/tcp": {}}, {"4321/tcp": {}}),
            ("Volumes", {"/data": {}}, {"/other": {}}),
            ("Labels", {"org.opencontainers.image.revision": COMMIT, "empty": ""},
             {"org.opencontainers.image.revision": COMMIT}),
        ]:
            with self.subTest(field=field):
                config = copy.deepcopy(self.config)
                config["config"][field] = original
                self.assertEqual(IDENTITY.verify_loaded(self.loaded(config), config, COMMIT), LOCAL_ID)
                loaded = self.loaded(config)
                loaded[0]["Config"][field] = changed
                with self.assertRaises(ValueError):
                    IDENTITY.verify_loaded(loaded, config, COMMIT)

    def test_numeric_zero_is_not_an_unspecified_boolean_default(self):
        loaded = self.loaded()
        loaded[0]["Config"]["StopTimeout"] = 0
        with self.assertRaises(ValueError):
            IDENTITY.verify_loaded(loaded, self.config, COMMIT)

    def test_wrong_or_additional_mutable_tags_are_rejected(self):
        for tags in [["jiashu-test:latest"], [TAG, "jiashu-test:latest"], []]:
            with self.subTest(tags=tags):
                path, source_id, _ = self.archive(tags=tags)
                with self.assertRaises(ValueError):
                    IDENTITY.archive_identity(path, COMMIT, source_id)

    def test_unknown_source_id_is_rejected(self):
        path, _, _ = self.archive()
        with self.assertRaises(ValueError):
            IDENTITY.archive_identity(path, COMMIT, "sha256:" + "c" * 64)

    def test_multiple_images_and_duplicate_archive_paths_are_rejected(self):
        for options in [{"count": 0}, {"count": 2}, {"duplicate": True}]:
            with self.subTest(options=options):
                path, source_id, _ = self.archive(**options)
                with self.assertRaises(ValueError):
                    IDENTITY.archive_identity(path, COMMIT, source_id)

    def test_archive_platform_and_revision_must_match(self):
        for field, value in [("architecture", "arm64"), ("os", "windows"), ("revision", "d" * 40)]:
            with self.subTest(field=field):
                config = copy.deepcopy(self.config)
                if field == "revision":
                    config["config"]["Labels"]["org.opencontainers.image.revision"] = value
                else:
                    config[field] = value
                path, source_id, _ = self.archive(config=config)
                with self.assertRaises(ValueError):
                    IDENTITY.archive_identity(path, COMMIT, source_id)

    def test_loaded_platform_revision_rootfs_and_configuration_must_match(self):
        changes = [
            lambda image: image.update(Os="windows"),
            lambda image: image.update(Architecture="arm64"),
            lambda image: image.update(Variant="v8"),
            lambda image: image["Config"].update(User="0"),
            lambda image: image["Config"]["Labels"].update({"org.opencontainers.image.revision": "d" * 40}),
            lambda image: image["RootFS"].update(Layers=["sha256:" + "c" * 64]),
            lambda image: image["RootFS"].update(Type="other"),
            lambda image: image.update(Id=TAG),
        ]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                loaded = self.loaded()
                change(loaded[0])
                with self.assertRaises(ValueError):
                    IDENTITY.verify_loaded(loaded, self.config, COMMIT)

    def test_inspect_must_describe_exactly_one_image(self):
        for loaded in [[], self.loaded() * 2, {}, [None]]:
            with self.subTest(loaded=loaded):
                with self.assertRaises(ValueError):
                    IDENTITY.verify_loaded(loaded, self.config, COMMIT)


if __name__ == "__main__":
    unittest.main()

extends "./ak-world.gd"
## Regression tests against the native outdoor scene and the actual debug walker.

func run() -> void:
    if not await exercise(0.20, true): return
    if not await exercise(0.65, false): return
    if not await exercise(-1.0, true): return
    if not await exercise_decoration(): return
    if not await exercise_assets(): return
    print("AK terrain physics checks passed.")
    quit()

func exercise(offset: float, should_cross: bool) -> bool:
    await load_world()
    var centre := Vector2(-246.0, 82.0)
    var start := centre - Vector2(3.4, 0.0)
    var base := sample(centre.x, centre.y)
    var near := sample(start.x, start.y)
    if base.is_empty() or near.is_empty():
        fail("The Royal Fountain terrain fixture is missing.")
        return false
    var new_height: float = base.position.y + offset
    var patched := apply_elevations([{"position": Vector3(centre.x, new_height, centre.y)}], offset < 0.0)
    if patched.has("error"):
        fail(patched.error)
        return false
    if offset < 0.0 and patched.cutMeshes == 0:
        fail("The original ground still covers the lowered preview surface.")
        return false
    await physics_frame
    await physics_frame
    var result := patched_sample(centre.x, centre.y)
    var outside := patched_sample(start.x, start.y)
    if result.is_empty() or result.collider != patched.body or absf(result.position.y - new_height) > 0.01:
        fail("Incorrect patched floor: " + str(result))
        return false
    if outside.is_empty() or outside.collider != near.collider or outside.position.distance_to(near.position) > 0.01:
        fail("The floor outside the patch changed.")
        return false

    var walker := make_walker(result.position)
    for frame in range(25):
        await physics_frame
        move_walker(walker, Vector3.ZERO)
    if not walker.is_on_floor() or absf(walker.global_position.y - new_height) > 0.02:
        fail("The saved test point did not land on the patched floor.")
        return false
    walker.global_position = outside.position + Vector3.UP * 0.15
    walker.velocity = Vector3.ZERO
    for frame in range(20):
        await physics_frame
        move_walker(walker, Vector3.ZERO)
    for frame in range(34):
        await physics_frame
        move_walker(walker, Vector3.RIGHT * 6.0)
    for frame in range(25):
        await physics_frame
        move_walker(walker, Vector3.ZERO)
    var walked := walker.global_position
    var crossed := walked.x > centre.x - 1.0
    var expected_y: float = new_height if should_cross else near.position.y
    if crossed != should_cross or not walker.is_on_floor() or absf(walked.y - expected_y) > 0.03:
        fail("Wrong walking result for %+.2f m: %s (expected Y %.3f)" % [offset, walked, expected_y])
        return false
    print("PASS %+.2f m · landed %.3f m · crossing %s" % [offset, walked.y, crossed])
    land.queue_free()
    await process_frame
    return true


func exercise_decoration() -> bool:
    await load_world()
    const CARD := "Vegetation/Tree0001/Oak/Card"
    # The tree is outside this preview area, so loading it depends on its source path.
    mount_nearby(Vector3(-254.0, 3.08, 82.0), [CARD])
    await physics_frame
    var tree := land.get_node_or_null(NodePath(CARD)) as Sprite3D
    if tree == null:
        fail("The edited tree's source chunk was not loaded.")
        return false
    var body := studio.card_root(tree).get_node_or_null("TrunkCollision") as StaticBody3D
    if body == null:
        fail("The tree collision fixture is missing.")
        return false
    var rid := body.get_rid()
    var original := tree.global_position
    var original_body: Transform3D = PhysicsServer3D.body_get_state(rid, PhysicsServer3D.BODY_STATE_TRANSFORM)
    var delta := Vector3(6.0, 1.0, 4.0)
    var moved: Dictionary = studio.prepare_cards({CARD: {"originalPosition": xyz(original), "position": xyz(original + delta)}})
    if moved.has("error"):
        fail(moved.error)
        return false
    studio.apply_cards(moved.edits)
    await physics_frame
    await physics_frame
    var moved_body: Transform3D = PhysicsServer3D.body_get_state(rid, PhysicsServer3D.BODY_STATE_TRANSFORM)
    if tree.global_position.distance_to(original + delta) > 0.005 or moved_body.origin.distance_to(original_body.origin + delta) > 0.005:
        fail("The tree and its collision did not move together.")
        return false
    var removed: Dictionary = studio.prepare_cards({CARD: {"originalPosition": xyz(tree.global_position), "position": null}})
    if removed.has("error"):
        fail(removed.error)
        return false
    studio.apply_cards(removed.edits)
    await physics_frame
    await physics_frame
    if is_instance_valid(tree) or is_instance_valid(body):
        fail("Removing the tree left a sprite or trunk collision.")
        return false
    print("PASS decoration movement and deletion with its native trunk collision")
    return true


func exercise_assets() -> bool:
    land.queue_free()
    await process_frame
    await load_world()
    var image := Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
    image.fill(Color(0.7, 0.2, 0.6, 1.0))
    var encoded := Marshalls.raw_to_base64(image.save_png_to_buffer())
    var fixture: Dictionary = JSON.parse_string(JSON.stringify({
        "atlas": {"png": encoded, "pixels": 16, "columns": 1, "count": 1},
        "textures": [{"tile": [38, 100], "top": 1, "side": 1}],
        "props": [{"tile": [38, 100], "texture": 1, "size": [1, 1.5], "blocked": true}],
        "blocked": []
    }))
    var patch: Dictionary = studio.read_assets(fixture)
    if patch.has("error"):
        fail(patch.error)
        return false
    var invalid := fixture.duplicate(true)
    invalid.props[0].texture = 2.0
    if not studio.read_assets(invalid).has("error"):
        fail("Missing atlas slot was accepted.")
        return false
    invalid = fixture.duplicate(true)
    invalid.atlas.pixels = 128.0
    if not studio.read_assets(invalid).has("error"):
        fail("Mismatched PNG dimensions were accepted.")
        return false
    patch.merge({"heights": {}, "changes": {}, "cards": {}})
    var applied: Dictionary = studio.apply_ground(patch, true)
    if applied.has("error") or applied.get("paintedTiles", []).size() != 1:
        fail("Custom ground did not paint: " + str(applied))
        return false
    await physics_frame
    await physics_frame
    studio.ground_bodies()
    var hit := sample(-246.0, 82.0)
    if hit.is_empty() or not studio.capsule_blocked(hit.position):
        fail("Custom decoration does not block the native player capsule.")
        return false
    var props := land.get_node_or_null("StudioProps")
    if props == null or props.find_children("*", "Sprite3D", true, false).size() != 1:
        fail("Custom decoration lost its visible sprite.")
        return false
    print("PASS portable PNG atlas, rejected invalid assets, custom ground and decoration collision")
    return true

import { rad, vec } from './math.ts';

/** Independent, provisional 550-class parameters. NOT measured TRON specifications. */
export const parameters = {
  mass: 3.2,
  gravity: 9.80665,
  density: 1.225,
  inertia: vec(0.035, 0.085, 0.16),
  rotor: {
    radius: 0.62, root: 0.095, chord: 0.048, blades: 2,
    inertia: 0.045, maxPitch: rad(13), liftSlope: 5.7,
    liftLimit: 1.25, profileDrag: 0.012, radialStations: 12, azimuthStations: 8,
    inflowTime: 0.09, discTime: 0.008, maxDiscTilt: rad(9), flapRateTime: 0.002,
    // Effective force derivatives at rho=1.225, radius=.62 m, 2100 RPM.
    // Identified from recorded motion, not blade geometry or HELI-X internals.
    // N/rad and N/(m/s); mass is deliberately absent from the force model.
    collectiveGain: 1521,
    axialGain: 15.78,
    inflowGain: 1.96,
    // Provisional reduced-order maneuver envelope, not measured blade polars.
    // Cyclic blade incidence is distinct from the achieved disc tilt.
    maxCyclicPitch: rad(12), cyclicTrackingGain: 4,
    stallAngle: rad(13), stallWidth: rad(7), stallDrag: 0.22,
    // Stronger high-incidence thrust loss; onset, control authority and recovery
    // stay separate so ordinary collective response is not softened.
    stallLiftLoss: 0.75, stallCyclicLoss: 0.25,
    separationAttack: 0.008, separationRecovery: 0.06,
    maneuverLoadScale: 1, // 0 only for controlled old/new diagnostic comparisons.
  },
  headHeight: 0.133,
  tailArm: 0.72,
  tailHeight: 0,
  // Effective authority matched to the identified main-rotor force model,
  // including the ideal governor's signed drive/braking torque. Acceptance:
  // ±12° pumps + 650°/s piro stops at 5 kg / 2400 RPM / 120% lift, 130% damping.
  // N at 2100 main RPM and 80:19 gearing; NOT a physical blade specification.
  tailMaxForce: 120,
  tailRadius: 0.105,
  tailResponseTime: 0.008,
  tailRatio: 80 / 19,
  motor: { torquePercent: 50, maxTorque: 8, maxPower: 2200, spoolTime: 1.5,
    // Gentle initial acceleration; full ramp rate is available above 900 RPM.
    // Keeps startup shaft-inertia torque modest before tail authority builds.
    startupRateFraction: .08, startupEndRPM: 900,
    responseTime: 0.025, loadFeedforward: 1, kp: 0.09, ki: 0.16, friction: 0.025 },
  controls: { maxAssistTilt: rad(24), servoSpeed: rad(900) },
  skidHeight: 0.142,
  dragArea: vec(0.025, 0.08, 0.1),
  bodyDragScale: 1,
  angularDamping: vec(0.075, 0.09, 0.15),
  // Effective hingeless-head cyclic stiffness, N·m/rad at 2100 RPM.
  // Independent provisional plant coefficient; does not change sign with collective.
  hubStiffness: 160,
};
export type Parameters = typeof parameters;

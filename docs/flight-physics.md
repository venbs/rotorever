# Rotorever 飞行控制与物理计算说明

> 对应版本：v0.2.0
>
> 代码基线：[77cfdfc](https://github.com/venbs/rotorever/tree/77cfdfc659b03dc5eb706c19c091832c0484e1d6)
>
> 整理日期：2026-10-15
> 范围：当前实际实现的输入、飞控、旋翼、电机、尾桨、刚体运动与地面接触。

本文以当前源码为准。公式中的数值示例使用**新用户默认机体配置**；已有浏览器配置会覆盖这些默认值。气动模型包含辨识系数和经验修正，不应将它们视为实测桨叶参数。

## 阅读导航

- [1. 整体计算流程](#1-整体计算流程)
- [2. 坐标、符号与通用函数](#2-坐标符号与通用函数)
- [3. 当前默认参数](#3-当前默认参数)
- [4. 摇杆输入与角速度目标](#4-摇杆输入与角速度目标)
- [5. 飞控：PID、前馈、自旋补偿](#5-飞控pid前馈自旋补偿)
- [6. 舵机与桨盘响应](#6-舵机与桨盘响应)
- [7. 主旋翼推力与动态入流](#7-主旋翼推力与动态入流)
- [8. 大总距与大循环的气动修正](#8-大总距与大循环的气动修正)
- [9. 电机、定速器与旋翼转速](#9-电机定速器与旋翼转速)
- [10. 尾桨与偏航控制](#10-尾桨与偏航控制)
- [11. 六自由度刚体运动](#11-六自由度刚体运动)
- [12. 地面接触与数值积分](#12-地面接触与数值积分)
- [13. 模型边界与代码索引](#13-模型边界与代码索引)
- [附录 A：低转速叶素分支](#附录-a低转速叶素分支)
- [附录 B：内部姿态辅助分支](#附录-b内部姿态辅助分支)

## 1. 整体计算流程

当前模型为：

**角速度飞控 → 有限速度执行器 → 旋翼与尾桨载荷 → 六自由度刚体 → 状态反馈。**

~~~mermaid
flowchart LR
    A["摇杆输入<br/>校准 / 死区 / Expo"] --> B["目标角速度<br/>PID / FF / Boost"]
    B --> C["舵机与桨盘响应"]
    C --> D["主桨推力与负载<br/>动态入流 / 分离修正"]
    D --> E["电机与尾桨<br/>定速 / 功率限制"]
    E --> F["合力与合力矩"]
    D --> F
    F --> G["刚体积分<br/>位置 / 姿态 / 速度"]
    G --> B
    G --> D
    E --> D
~~~

每个动力学子步按以下顺序执行：

1. 计算相对空气速度、角速度目标。
2. 更新自旋补偿、滤波状态和 PID 积分，计算目标力矩。
3. 更新总距舵机、周期操纵执行器及桨盘方向。
4. 计算基础主桨载荷，再叠加机动分离与做功修正。
5. 根据本步推力更新动态入流状态。
6. 更新电机、尾桨、主轴反扭矩及旋翼转速。
7. 汇总空气动力、重力、力矩与地面接触。
8. 积分速度、角速度、位置和四元数姿态。

**状态时序：**飞控反算使用上一子步的推力和主轴反扭矩；本步气动载荷使用更新前的诱导速度。入流随后更新，供下一子步使用。各模块按顺序推进，并非同时求解全部状态。

## 2. 坐标、符号与通用函数

### 2.1 坐标约定

采用右手系，机体系和初始世界系均为：

| 轴 | 方向 | 绕该轴的角运动 |
| --- | --- | --- |
| X | 向前 | 横滚；正方向为向右滚转 |
| Y | 向上 | 偏航；正方向为向左偏航 |
| Z | 向右 | 俯仰；正方向为抬头 |

世界坐标系不随飞机旋转。姿态四元数 $q$ 对应的旋转矩阵 $\mathcal R(q)$ 将机体系向量转换到世界系。

所有核心角度使用弧度，时间使用秒：

$$
\Omega=\mathrm{RPM}\frac{\pi}{30},
\qquad
\theta_{\mathrm{rad}}=\theta_{\mathrm{deg}}\frac{\pi}{180}
$$

### 2.2 主要符号

| 符号 | 含义 | 单位 |
| --- | --- | --- |
| $\mathbf p,\mathbf v$ | 世界系位置、速度 | m、m/s |
| $\boldsymbol\omega=(\omega_x,\omega_y,\omega_z)$ | 机体系角速度 | rad/s |
| $q,\mathcal R(q)$ | 姿态四元数、机体到世界旋转矩阵 | 无量纲 |
| $I=\operatorname{diag}(I_x,I_y,I_z)$ | 机体转动惯量矩阵 | kg·m² |
| $\Omega,\Omega_t$ | 主旋翼、尾旋翼转速 | rad/s |
| $J_r$ | 主旋翼等效转动惯量 | kg·m² |
| $\theta_0,\theta_1$ | 实际总距、估算的等效循环变距幅度 | rad |
| $\delta_r,\delta_p$ | 横滚、俯仰执行器状态 | rad |
| $\beta_r,\beta_p,\mathbf n$ | 桨盘倾角及单位法向量 | rad、无量纲 |
| $V_a,V_t$ | 桨盘轴向、平面内相对空气速度 | m/s |
| $v_i$ | 带符号的均匀诱导速度 | m/s |
| $T_0,T$ | 基础主桨推力、修正后主桨推力 | N |
| $F_t$ | 带符号的尾桨侧推力 | N |
| $Q_a,Q_m,Q_t,Q_f$ | 主桨气动、电机、尾桨折算负载、摩擦扭矩 | N·m |
| $Q_{\mathrm{reaction}}$ | 主轴对机体的偏航反作用扭矩 | N·m |
| $S,\eta_T,\eta_c$ | 有效分离程度、推力效率、桨毂操纵效率 | 无量纲 |
| $R,r_0,c,N_b$ | 主桨半径、桨根半径、弦长、桨叶数 | m、m、m、无量纲 |
| $\Delta t$ | 动力学子步长度 | s |

**注意：**$\boldsymbol\omega$ 是机体转动速度，$\Omega$ 是旋翼转速；$I$ 是机体惯量，$J_r$ 是旋翼惯量，二者不能混用。

### 2.3 限幅、一阶响应与滤波

限幅函数：

$$
\operatorname{clip}(x,a,b)=\max(a,\min(b,x))
$$

代码中统一的一阶响应：

$$
\mathcal L_\tau(x,x^*)
=
x+(x^*-x)\left(1-e^{-\Delta t/\tau}\right)
$$

以截止频率表示时：

$$
\tau=\frac{1}{2\pi f_c}
$$

后文上标 $+$ 表示更新后的状态，星号 $*$ 表示目标值。

## 3. 当前默认参数

### 3.1 新用户实际应用的预设

来源：[aircraft-settings.ts](../src/aircraft-settings.ts)，defaultAircraft。

| 设置 | 默认值 |
| --- | --- |
| 起飞质量 | 2.8 kg |
| 目标主桨转速 | 2150 RPM |
| 电机扭矩设置 | 50% |
| 总距范围 | ±12° |
| 横滚 / 俯仰最大速率 | 350°/s |
| 偏航最大速率 | 650°/s |
| Expo | 40% |
| 总距升力增益 | 70% |
| 旋翼轴向阻尼 | 120% |
| 机身空气阻力 | 100% |
| 自旋误差旋转 | 开启，100% |

飞控默认值：

| 通道 | P | I | D | FF | Boost |
| --- | ---: | ---: | ---: | ---: | ---: |
| 横滚 | 50 | 30 | 0 | 150% | 40% |
| 俯仰 | 50 | 30 | 0 | 150% | 40% |
| 偏航 | 85 | 30 | 0.35 | 0% | 40% |

D / Boost / I Relax 的截止频率分别为 **60 / 25 / 12 Hz**。这些增益采用本模拟器的扭矩域定义，不能直接当作其他飞控的同名参数。

### 3.2 固定的物理参考参数

来源：[parameters.ts](../src/physics/parameters.ts)。

| 参数 | 数值 |
| --- | --- |
| 重力加速度 $g$ | 9.80665 m/s² |
| 空气密度 $\rho$ | 1.225 kg/m³ |
| 主桨半径 $R$ / 桨根半径 $r_0$ | 0.62 / 0.095 m |
| 桨叶数 $N_b$ / 弦长 $c$ | 2 / 0.048 m |
| 主旋翼惯量 $J_r$ | 0.045 kg·m² |
| 参考机体质量 | 3.2 kg |
| 参考机体惯量 $(I_x,I_y,I_z)$ | (0.035, 0.085, 0.16) kg·m² |
| 主桨作用点高度 $h_h$ | 0.133 m |
| 尾桨力臂 $l_t$ / 半径 $R_t$ | 0.72 / 0.105 m |
| 尾传动比 $g_t$ | 80 / 19 |
| 桨毂刚度系数 $K_h$ | 160 N·m/rad |
| 桨盘最大倾角 | ±9° |
| 执行器最大速度 $v_s$ | 900°/s |
| 桨盘 / 尾桨响应时间 | 8 / 8 ms |
| 入流响应时间 | 90 ms |

物理模块的参考配置和应用层默认预设不同。应用预设后，机体惯量按质量同比例缩放：

$$
I=\frac{m}{3.2}
\operatorname{diag}(0.035,0.085,0.16)
$$

例如默认质量 2.8 kg 时，惯量为：

$$
I=\operatorname{diag}(0.030625,0.074375,0.14)\ \mathrm{kg\,m^2}
$$

这里假定增减质量不改变相对质量分布；主旋翼惯量 $J_r$ 不随此设置改变。

## 4. 摇杆输入与角速度目标

来源：[rates.ts](../src/physics/rates.ts)，expoCurve / rateCommand。

校准、死区与反向处理后的输入为 $u\in[-1,1]$。常规三次 Expo：

$$
f(u)=(1-e)u+eu^3
$$

默认 $e=0.4$，因此半杆输出 $f(0.5)=0.35$，满杆仍为 1。

角速度模式下：

$$
\boldsymbol\omega_d=
\begin{bmatrix}
R_c f(u_{\mathrm{roll}})\\
-R_y f(u_{\mathrm{yaw}})\\
-R_c f(u_{\mathrm{pitch}})
\end{bmatrix}
$$

$R_c,R_y$ 为配置的最大角速度，须先从 °/s 转为 rad/s。负号用于匹配项目轴向与操作习惯。

总距不经过 Expo：

$$
\theta_{\mathrm{target}}
=
\theta_{\max}\operatorname{clip}(u_{\mathrm{collective}},-1,1)
$$

方向杆设定角速度目标，总距杆设定桨距目标。实际角速度与桨距还要经过飞控、执行器和动力学。

## 5. 飞控：PID、前馈、自旋补偿

来源：[simulator.ts](../src/physics/simulator.ts)，integrateStep；[fbl.ts](../src/physics/fbl.ts)。

### 5.1 目标力矩

每轴角速度误差为：

$$
e_i=\omega_{d,i}-\omega_i
$$

离散导数经过低通：

$$
D_i^+=\mathcal L_{\tau_D}
\left(D_i,\frac{\omega_i-\omega_{i,\mathrm{prev}}}{\Delta t}\right)
$$

$$
B_i^+=\mathcal L_{\tau_B}
\left(B_i,\frac{\omega_{d,i}-\omega_{d,i,\mathrm{prev}}}{\Delta t}\right)
$$

目标力矩：

$$
\boxed{
M_{\mathrm{cmd},i}
=
I_i\left(
K_{P,i}e_i
+K_{I,i}E_i
-K_{D,i}D_i^+
+\frac{b_i}{100}B_i^+
\right)
+
\frac{FF_i}{100}C_i\omega_{d,i}
+
[\boldsymbol\omega\times(I\boldsymbol\omega)]_i
}
$$

| 项 | 作用 |
| --- | --- |
| P | 根据当前角速度误差施加力矩 |
| I | 消除持续误差 |
| D | 抑制实际角速度的快速变化 |
| FF | 补偿持续旋转的角速度阻尼 |
| Boost | 根据目标角速度变化增加加速力矩 |
| 刚体耦合补偿 | 补偿 $\boldsymbol\omega\times(I\boldsymbol\omega)$ 项 |

角速度阻尼系数：

$$
(C_x,C_y,C_z)=(0.075,0.09,0.15)
$$

目标力矩通过后续执行器限幅实现，不能直接等同于最终实际力矩。

### 5.2 I Relax 与抗饱和

目标角速度的低通状态：

$$
\omega_{d,f,i}^+
=
\mathcal L_{\tau_{\mathrm{relax}}}(\omega_{d,f,i},\omega_{d,i})
$$

积分放松系数：

$$
\lambda_i
=
\operatorname{clip}
\left(
1-\frac{|\omega_{d,i}-\omega_{d,f,i}^+|}{40\pi/180},
0,1
\right)
$$

积分更新：

$$
E_i^+
=
\operatorname{clip}
(E_i+\gamma_i e_i\Delta t,-0.4,0.4)
$$

若误差正在消除已有积分，即 $e_iE_i<0$，则 $\gamma_i=1$；否则 $\gamma_i=\lambda_i$。

实际代码还有以下条件：

- 只有离地且转速比 $r_\Omega>0.3$ 才允许积分；否则清零。
- 当需求超出执行器能力，且误差继续推动同方向饱和时，冻结积分。
- 偏航饱和判断使用 $M_{\mathrm{cmd},y}-Q_{\mathrm{reaction,prev}}$。
- 该轴 I 增益为零时，清零对应积分。

### 5.3 自旋时旋转累计误差

开启误差旋转时，在本步积分更新之前执行：

$$
\Delta\psi=\omega_y\Delta t\frac{G_{\mathrm{piro}}}{100}
$$

$$
\begin{bmatrix}E_x'\\E_z'\end{bmatrix}
=
\begin{bmatrix}
\cos\Delta\psi&-\sin\Delta\psi\\
\sin\Delta\psi&\cos\Delta\psi
\end{bmatrix}
\begin{bmatrix}E_x\\E_z\end{bmatrix}
$$

旋转后的两个分量各自限制在 ±0.4 rad。偏航积分 $E_y$ 保持不变。补偿使用机体实际偏航角速度，不使用尾舵杆量。

## 6. 舵机与桨盘响应

来源：[simulator.ts](../src/physics/simulator.ts)，integrateStep。

### 6.1 由力矩反算周期操纵

参考转速与转速比：

$$
\Omega_{\mathrm{ref}}=2100\frac{\pi}{30},
\qquad
r_\Omega=\frac{\Omega}{\Omega_{\mathrm{ref}}}
$$

反算力矩系数：

$$
K_c=\max(0.1,K_h r_\Omega^2+h_hT_{\mathrm{prev}})
$$

周期操纵目标：

$$
\delta_r^*
=
\operatorname{clip}
\left(
\frac{M_{\mathrm{cmd},x}}{K_c}
+\tau_f\omega_x,
-\beta_{\max},\beta_{\max}
\right)
$$

$$
\delta_p^*
=
\operatorname{clip}
\left(
-\frac{M_{\mathrm{cmd},z}}{K_c}
-\tau_f\omega_z,
-\beta_{\max},\beta_{\max}
\right)
$$

其中 $\tau_f=0.002$ s，$\beta_{\max}=9^\circ$。

### 6.2 执行器速度限制

总距和两个周期执行器都使用：

$$
\delta^+
=
\delta+
\operatorname{clip}
(\delta^*-\delta,-v_s\Delta t,v_s\Delta t)
$$

其中 $v_s=900^\circ/s$。对总距而言，$\delta=\theta_0$，$\delta^*=\theta_{\mathrm{target}}$。

### 6.3 桨盘响应与推力方向

$$
\begin{aligned}
\beta_r^+&=\mathcal L_{0.008}(\beta_r,\delta_r^+-0.002\omega_x)\\
\beta_p^+&=\mathcal L_{0.008}(\beta_p,\delta_p^++0.002\omega_z)
\end{aligned}
$$

下面省略倾角的更新上标：

$$
\boxed{
\mathbf n=
\frac{(\sin\beta_p,1,\sin\beta_r)}
{\sqrt{1+\sin^2\beta_p+\sin^2\beta_r}}
}
$$

这是代码实际采用的法向量构造方式。它是等效桨盘模型，执行器角度不能直接解释成真实机械循环桨距。

## 7. 主旋翼推力与动态入流

来源：[rotor.ts](../src/physics/rotor.ts)，rotorLoads / equilibriumInflow。

### 7.1 相对空气速度

$$
\mathbf V_b=\mathcal R(q)^T(\mathbf v-\mathbf v_{\mathrm{wind}})
$$

$$
V_a=\mathbf V_b\cdot\mathbf n,
\qquad
V_t=\sqrt{\max(0,\|\mathbf V_b\|^2-V_a^2)}
$$

当前应用默认无风。若内部 wind 参数 $w>0$，风场为：

$$
\mathbf v_{\mathrm{wind}}
=
w(0.15\sin(0.67t),\;0,\;1+0.12\sin(0.39t))
$$

### 7.2 有效总距与软饱和

$$
\theta_{\mathrm{eff}}=
\begin{cases}
\theta_0,&|\theta_0|\le15^\circ\\
\operatorname{sgn}(\theta_0)
\left[
15^\circ+10^\circ
\tanh\left(\dfrac{|\theta_0|-15^\circ}{10^\circ}\right)
\right],
&|\theta_0|>15^\circ
\end{cases}
$$

式中的度数在程序内均换算成弧度。默认 ±12° 总距不触发这层软饱和，但仍可能触发第 8 节的局部高迎角修正。

### 7.3 基础推力

定义几何、空气密度缩放：

$$
r_R=\frac{R}{0.62},
\qquad
r_\sigma=
\frac{N_bc/R}{2\times0.048/0.62},
\qquad
r_\rho=\frac{\rho}{1.225}
$$

正常转速下的基础推力为：

$$
\boxed{
T_0=
r_\rho r_\sigma
\left[
K_\theta r_R^4r_\Omega^2\theta_{\mathrm{eff}}
-r_R^3r_\Omega(K_aV_a+K_iv_i)
\right]
}
$$

参数映射：

$$
K_\theta=1521g_L,\qquad K_a=15.78g_A,\qquad K_i=1.96
$$

$g_L$ 为“总距升力增益 / 100”，$g_A$ 为“旋翼轴向阻尼 / 100”。

默认 $g_L=0.70,\;g_A=1.20$，且当前几何和空气密度缩放均为 1，所以：

$$
\boxed{
T_0=
1064.7r_\Omega^2\theta_{\mathrm{eff}}
-r_\Omega(18.936V_a+1.96v_i)
}
$$

**参数作用范围：**升力增益只缩放总距项；轴向阻尼只缩放 $V_a$ 项。它们都没有直接缩放整个最终推力。

$T_0$ 保留正负号，负总距可以产生负推力。该公式不包含质量；质量通过后续 $F=ma$ 和惯量影响运动。

### 7.4 诱导速度目标

使用最终推力 $T$ 计算：

$$
A=\pi R^2,\qquad
v_h=\sqrt{\frac{|T|}{2\rho A}},
\qquad d=\operatorname{sgn}(T)
$$

从 $x_0=v_h$ 开始，执行 12 次松弛迭代：

$$
U_k=
\sqrt{V_t^2+(V_ad+x_k)^2+(0.3v_h)^2+0.01}
$$

$$
x_{k+1}
=
0.65x_k+
0.35\min\left(\frac{|T|}{2\rho AU_k},2.5v_h\right)
$$

得到：

$$
v_i^*=dx_{12},
\qquad
v_i^+=\mathcal L_{0.09}(v_i,v_i^*)
$$

$(0.3v_h)^2+0.01$ 和 $2.5v_h$ 上限用于正则化。它们是当前数值模型的一部分，不是额外的实测气动关系。

### 7.5 高速平移如何影响推力

$V_t$ 增大会改变入流目标。在相同转速、总距、轴向速度且未发生其他效率变化的条件下，诱导速度幅值降低通常会减小推力公式中的入流损失，形成简化的平移增升。

当前没有额外叠加“速度乘升力倍率”。高速同时会增加剖面功耗和机身阻力；最终运动还取决于姿态、轴向来流、分离程度和实际转速。

## 8. 大总距与大循环的气动修正

来源：[rotor-maneuver.ts](../src/physics/rotor-maneuver.ts)。

### 8.1 等效循环变距与局部迎角

$$
\theta_1=
\min\left(
12^\circ,
\sqrt{\delta_r^2+\delta_p^2}
+
4\frac{\sqrt{\omega_x^2+\omega_z^2}}{\max(\Omega,40)}
\right)
$$

该值由执行器与机体角速度近似重建，是模型内部的等效量。

使用代表半径 $0.75R$，取八个方位：

$$
\psi_j=\frac{j\pi}{4},\quad j=0,\ldots,7
$$

$$
\phi=
\operatorname{atan2}(V_a+v_i,\max(0.75R\Omega,1))
$$

$$
\alpha_j=\theta_0+\theta_1\cos\psi_j-\phi
$$

### 8.2 分离状态与效率

$$
z_j=\operatorname{clip}
\left(\frac{|\alpha_j|-13^\circ}{7^\circ},0,1\right)
$$

$$
S^*=\frac18\sum_{j=0}^{7}z_j^2(3-2z_j)
$$

$$
S^+=\mathcal L_{\tau_S}(S,S^*),
\qquad
\tau_S=
\begin{cases}
0.008,&S^*>S\\
0.06,&S^*\le S
\end{cases}
$$

下文 $S$ 指更新后的状态。定义修正接入比例：

$$
\chi=
\operatorname{clip}\left(\frac{\Omega-40}{40},0,1\right)
g_{\mathrm{maneuver}}
$$

当前 $g_{\mathrm{maneuver}}=1$。因此低于约 382 RPM 不接入，超过约 764 RPM 完全接入。

$$
\eta_T=1-0.75\chi S,
\qquad
\eta_c=1-0.25\chi S
$$

$$
\boxed{T=T_0\eta_T}
$$

$S$ 是有效分离状态，不是实测的桨盘失速面积比例。

### 8.3 气动负载与旋转做功

主桨基础剖面扭矩：

$$
Q_{\mathrm{profile}}
=
\frac{N_b\rho c(R^4-r_0^4)}8
C_{D0}\left(\Omega^2+\frac{3V_t^2}{R^2}\right)
$$

基础气动扭矩：

$$
Q_0=Q_{\mathrm{profile}}+
\frac{T_0(V_a+v_i)}{\max(\Omega,1)}
$$

其中 $C_{D0}=0.012$。附加阻力系数与扭矩为：

$$
\Delta C_D
=
0.018\frac{(5.7\theta_1)^2}{2}+0.22S
$$

$$
\Delta Q_D=
\chi\frac{N_b\rho c(R^4-r_0^4)}8\Omega^2\Delta C_D
$$

主旋翼横滚、俯仰力矩：

$$
\begin{aligned}
M_{r,x}&=h_hTn_z+K_hr_\Omega^2\eta_c\beta_r\\
M_{r,z}&=-h_hTn_x-K_hr_\Omega^2\eta_c\beta_p
\end{aligned}
$$

旋转做功负载：

$$
Q_{\mathrm{work}}
=
\chi
\frac{\max(0,M_{r,x}\omega_x+M_{r,z}\omega_z)}
{\max(\Omega,40)}
$$

最终主桨气动扭矩：

$$
\boxed{
Q_a=
Q_0+
\frac{(T-T_0)(V_a+v_i)}{\max(\Omega,1)}
+\Delta Q_D+Q_{\mathrm{work}}
}
$$

修正后的推力重新进入轴向功率项，避免同时收取旧推力和新推力的功耗。旋转负做功不作为能量回收计入。

当 $\Omega<40$ rad/s 时，$T_0,Q_0$ 使用附录 A 的混合结果；此时 $\chi=0$，机动修正不生效。

## 9. 电机、定速器与旋翼转速

来源：[simulator.ts](../src/physics/simulator.ts)，integrateStep。

### 9.1 启动转速斜坡

目标 RPM 限制在 1200～3000 之间。定义：

$$
s_{\mathrm{start}}
=
\operatorname{clip}
\left(\frac{\Omega}{900\pi/30},0,1\right)
$$

$$
a_{\mathrm{spool}}
=
\frac{\Omega_{\mathrm{ref}}}{1.5}
\left(0.08+0.92s_{\mathrm{start}}^2\right)
$$

电机解锁时：

$$
\Omega_{\mathrm{sp}}^+
=
\min(\Omega_{\mathrm{target}},
\Omega_{\mathrm{sp}}+a_{\mathrm{spool}}\Delta t)
$$

电机关闭时，设定值直接归零，但实际旋翼保留惯量。降低目标转速时，设定值可以直接降至新目标；普通电机分支仍通过扭矩平衡改变实际转速。

### 9.2 普通电机模式

电机扭矩设置为 $p_m\%$：

$$
s_m=\frac{\operatorname{clip}(p_m,10,100)}{50}
$$

$$
K_{P,m}=0.09s_m,\qquad K_{I,m}=0.16s_m
$$

$$
Q_{\max}
=
s_m\min\left(8,\frac{2200}{\max(\Omega,30)}\right)
$$

旋翼加速前馈：

$$
Q_{\mathrm{spin}}
=
J_r\max\left(0,\frac{\Omega_{\mathrm{sp}}^+-\Omega_{\mathrm{sp}}}{\Delta t}\right)
$$

关闭电机时 $Q_{\mathrm{spin}}=0$。当前负载前馈增益为 1：

$$
Q_{\mathrm{ff}}
=
\max(0,Q_a+Q_{t,\mathrm{previous\ force}}+Q_f+Q_{\mathrm{spin}})
$$

这里的尾桨负载前馈使用上一状态的尾桨力、本步更新前的转速。随后尾桨求解会得到本步的实际负载。

$$
e_\Omega=\Omega_{\mathrm{sp}}^+-\Omega
$$

$$
Q_{\mathrm{demand}}
=
Q_{\mathrm{ff}}+K_{P,m}e_\Omega+K_{I,m}E_\Omega
$$

定速器积分只在输出未饱和或误差有助于退出饱和时更新：

$$
E_\Omega^+
=
\operatorname{clip}
\left(
E_\Omega+e_\Omega\Delta t,
-\frac{Q_{\max}}{K_{I,m}},
\frac{Q_{\max}}{K_{I,m}}
\right)
$$

关闭电机时积分清零。使用更新后的积分重新计算需求，再限制为 $Q_{\mathrm{cmd}}\in[0,Q_{\max}]$。

电机输出经一阶响应：

$$
Q_m^+
=
\operatorname{clip}
\left(
\mathcal L_{\tau_m}(Q_m,Q_{\mathrm{cmd}}),
0,Q_{\max}
\right)
$$

解锁时 $\tau_m=0.025/s_m$；关闭时目标扭矩为 0，$\tau_m=0.025$。

最终旋翼转速更新：

$$
\boxed{
\Omega^+
=
\max\left(
0,\;
\Omega+
\frac{Q_m^+-Q_a-Q_t-Q_f}{J_r}\Delta t
\right)
}
$$

$J_r=0.045$ kg·m²；$\Omega>0$ 时 $Q_f=0.025$ N·m，否则 $Q_f=0$。

### 9.3 100% 电机设置：理想定速

仅在电机解锁且设置达到 100% 时启用：

$$
\Omega^+
=
\Omega+
\operatorname{clip}
\left(
\Omega_{\mathrm{sp}}^+-\Omega,
-a_{\mathrm{spool}}\Delta t,
a_{\mathrm{spool}}\Delta t
\right)
$$

按所需加速度反算主轴与电机扭矩：

$$
Q_{\mathrm{reaction}}
=
Q_a+J_r\frac{\Omega^+-\Omega}{\Delta t}
$$

$$
Q_m=Q_{\mathrm{reaction}}+Q_f+Q_t
$$

该分支允许提供或吸收维持转速所需的扭矩，不受普通电机分支的输出上限约束。启动和转速调整仍有斜坡；稳定到目标后不因负载掉转。桨叶分离导致的效率损失仍然保留。

## 10. 尾桨与偏航控制

来源：[tail.ts](../src/physics/tail.ts) 和 [simulator.ts](../src/physics/simulator.ts)。

### 10.1 转速与推力上限

$$
\Omega_t=g_t\max(\Omega,0),
\qquad g_t=\frac{80}{19}
$$

参考尾桨转速：

$$
\Omega_{t,\mathrm{ref}}=\Omega_{\mathrm{ref}}\frac{80}{19}
$$

推力上限：

$$
F_{t,\max}
=
120\frac{\rho}{1.225}
\left(\frac{\Omega_t}{\Omega_{t,\mathrm{ref}}}\right)^2
$$

关闭电机不会立即停尾桨，尾桨转速继续跟随主旋翼。

### 10.2 反扭矩补偿与执行器响应

归一化尾桨桨距状态为 $u_t\in[-1,1]$。定义：

$$
a_t=1-e^{-\Delta t/0.008},
\qquad
u_{\mathrm{pre}}=
-\frac{Q_{\mathrm{reaction}}}{l_tF_{t,\max}}
$$

只对已知负载预补偿增加超前项：

$$
u_{\mathrm{lead}}
=
(u_{\mathrm{pre}}-u_{\mathrm{pre,prev}})
\frac{1-a_t}{a_t}
$$

尾桨指令：

$$
u_t^*
=
\operatorname{clip}
\left(
u_{\mathrm{pre}}+u_{\mathrm{lead}}
+\frac{M_{\mathrm{cmd},y}}{l_tF_{t,\max}},
-1,1
\right)
$$

$$
u_t^+=u_t+a_t(u_t^*-u_t),
\qquad
F_t=F_{t,\max}u_t^+
$$

当推力上限接近零时，代码跳过上述除法并令尾桨力为零。

### 10.3 尾桨功耗与主轴反作用扭矩

尾桨负载折算到主轴：

$$
Q_t=
\frac{
\dfrac{|F_t|^{3/2}}{0.72\sqrt{2\rho\pi R_t^2}}
+
16\frac{\rho}{1.225}
\left(\dfrac{\Omega_t}{\Omega_{t,\mathrm{ref}}}\right)^3
}
{\max(\Omega,20)}
$$

普通电机模式下：

$$
Q_{\mathrm{reaction}}=Q_m-Q_t-Q_f
$$

尾桨力影响尾桨功耗，功耗又影响主轴反作用扭矩。因此代码执行 12 次固定点迭代求解这项耦合。

**力矩用途：**$Q_t$ 是动力系统负载；机体偏航方程使用 $Q_{\mathrm{reaction}}$，不把尾桨功耗再额外加成一个偏航力矩。

## 11. 六自由度刚体运动

来源：[simulator.ts](../src/physics/simulator.ts)，integrateStep。

### 11.1 机体系空气动力

主桨与尾桨力：

$$
\mathbf F_r=T\mathbf n,
\qquad
\mathbf F_t=(0,0,F_t)
$$

机身各轴阻力：

$$
F_{D,i}
=
-g_D
\left(
\frac12\rho A_iV_{b,i}|V_{b,i}|
+0.02V_{b,i}
\right)
$$

其中 $g_D$ 为“机身空气阻力 / 100”，默认 1：

$$
(A_x,A_y,A_z)=(0.025,0.08,0.10)\ \mathrm{m^2}
$$

### 11.2 平动

$$
\mathbf F_{\mathrm{world}}
=
\mathcal R(q)(\mathbf F_r+\mathbf F_t+\mathbf F_D)
+(0,-mg,0)
+\mathbf F_{\mathrm{ground}}
$$

$$
\boxed{\dot{\mathbf v}=\frac{\mathbf F_{\mathrm{world}}}{m}}
$$

### 11.3 转动

主桨和尾桨作用点：

$$
\mathbf r_h=(0,0.133,0),
\qquad
\mathbf r_t=(-0.72,0,0)
$$

合力矩：

$$
\mathbf M
=
\mathbf r_h\times\mathbf F_r
+
\mathbf r_t\times\mathbf F_t
+
\begin{bmatrix}
K_hr_\Omega^2\eta_c\beta_r\\
Q_{\mathrm{reaction}}\\
-K_hr_\Omega^2\eta_c\beta_p
\end{bmatrix}
-
\mathbf C\odot\boldsymbol\omega
+
\mathbf M_{\mathrm{ground}}
$$

$\odot$ 表示逐分量相乘。刚体角加速度：

$$
\boxed{
\dot{\boldsymbol\omega}
=
I^{-1}
\left[
\mathbf M-\boldsymbol\omega\times(I\boldsymbol\omega)
\right]
}
$$

实际姿态由此积分得到，飞控不会直接把机体角速度改成目标值。

## 12. 地面接触与数值积分

来源：[ground.ts](../src/physics/ground.ts)、[simulator.ts](../src/physics/simulator.ts)、[math.ts](../src/physics/math.ts)。

### 12.1 四点起落架接触

机体系接触点为：

$$
\mathbf r_j=(\pm0.15,-0.142,\pm0.078)
$$

地面高度为 $y_g$，当前三张地图均为 0。接触点高度和世界系速度：

$$
h_j=p_y+[\mathcal R(q)\mathbf r_j]_y-y_g
$$

$$
\mathbf v_j=\mathbf v+\mathcal R(q)(\boldsymbol\omega\times\mathbf r_j)
$$

只有 $h_j<0$ 时计算支持力：

$$
N_j=\max(0,-2200h_j-42v_{j,y})
$$

对应接触力为 $(0,N_j,0)$，并按作用点计算对机体的力矩。

### 12.2 摩擦冲量

法向冲量：

$$
J_{n,j}=N_j\Delta t
$$

切向冲量满足库仑限幅：

$$
\|\mathbf J_{t,j}\|\le0.65J_{n,j}
$$

四个接触点采用 12 次顺序冲量迭代，消除可被静摩擦抵消的滑动，超出上限时保留滑动。冲量同时修改线速度和角速度，不直接锁定姿态。

### 12.3 固定步长积分

外层输入与调度频率为 **250 Hz**，每步 4 ms；每步再拆成两个 **2 ms** 动力学子步，相当于 **500 Hz** 内部更新。

先更新速度和角速度：

$$
\mathbf v^*=\mathbf v_n+\frac{\mathbf F_n}{m}\Delta t
$$

$$
\boldsymbol\omega^*
=
\boldsymbol\omega_n+
I^{-1}
\left[
\mathbf M_n-\boldsymbol\omega_n\times(I\boldsymbol\omega_n)
\right]\Delta t
$$

接地时再施加摩擦冲量，得到 $\mathbf v_{n+1},\boldsymbol\omega_{n+1}$。之后用新速度更新位置：

$$
\mathbf p_{n+1}=\mathbf p_n+\mathbf v_{n+1}\Delta t
$$

姿态使用新旧角速度的中值：

$$
\bar{\boldsymbol\omega}
=
\frac{\boldsymbol\omega_n+\boldsymbol\omega_{n+1}}2
$$

令 $\theta=\|\bar{\boldsymbol\omega}\|\Delta t$，当角速度不为零时：

$$
\Delta q=
\left(
\frac{\bar{\boldsymbol\omega}}{\|\bar{\boldsymbol\omega}\|}
\sin\frac{\theta}{2},
\cos\frac{\theta}{2}
\right)
$$

$$
q_{n+1}=\operatorname{normalize}(q_n\otimes\Delta q)
$$

角速度接近零时保持姿态。$\otimes$ 为四元数乘法，四元数按“向量部分、标量部分”书写。

渲染只插值物理状态。超长帧最多接收 0.1 s 墙钟时间，超过部分丢弃，不用巨大的积分步长追赶。

### 12.4 碰撞与炸机判定

当前主要判定包括：

| 条件 | 结果 |
| --- | --- |
| 接地点已穿地，且其向下速度超过 2.8 m/s | 炸机 |
| 接地点已穿地，且机体向上轴与世界向上的夹角余弦低于 0.55 | 炸机 |
| 接地点穿透超过 0.15 m | 炸机 |
| 旋翼盘近似最低点触地，且主旋翼转速大于 20 rad/s | 炸机 |
| 位置 / 角速度出现非有限数，或角速度模长超过 150 rad/s | 数值保护，判为炸机 |

桨盘触地使用机体主轴方向和半径估算，尚未逐片检测桨叶几何。应用层在炸机后复位，复位属于交互逻辑，不是气动力公式。

## 13. 模型边界与代码索引

### 13.1 当前已实现

- 有限幅度、有限速度的执行器与桨盘动态。
- 扭矩域 PID、稳态 FF、Boost、I Relax 和自旋误差旋转。
- 带符号总距推力、均匀动态入流、简化平移增升。
- 有效高迎角分离、推力损失、附加阻力和旋转做功负载。
- 电机扭矩 / 功率限制、尾桨功耗与旋翼惯量。
- 六自由度刚体运动、四点起落架接触与摩擦冲量。

### 13.2 当前简化范围

- 正常飞行的主桨推力使用辨识后的降阶模型，非逐桨叶全方位求解。
- 高速前飞的前行 / 后行桨叶不对称与后行桨失速尚未完整建模。
- 均匀入流不能替代空间尾迹、涡环状态和强下降流动模型。
- 分离状态不是包含涡脱落过程的完整动态失速模型。
- 未求解桨叶弹性、摆振、结构折叠及 BVI 声音。
- 尾桨使用等效推力与功耗，未完整求解尾桨尾迹或桨叶失速。
- 地面为统一平面；照片中的建筑、树木、水面没有独立碰撞体。
- 100% 电机设置是明确的理想定速模式。

### 13.3 源码定位

| 模块 | 文件 | 主要入口 |
| --- | --- | --- |
| 应用预设与参数映射 | [aircraft-settings.ts](../src/aircraft-settings.ts) | defaultAircraft、applyAircraft |
| 参考物理参数 | [parameters.ts](../src/physics/parameters.ts) | parameters |
| Expo 与 Rates | [rates.ts](../src/physics/rates.ts) | expoCurve、rateCommand |
| 飞控配置与自旋补偿 | [fbl.ts](../src/physics/fbl.ts) | rotateCyclicError |
| 基础主桨与入流 | [rotor.ts](../src/physics/rotor.ts) | rotorLoads、equilibriumInflow、bladeElementLoads |
| 机动分离与附加负载 | [rotor-maneuver.ts](../src/physics/rotor-maneuver.ts) | bladeCyclicPitch、maneuverLoads |
| 尾桨转速、推力及功耗 | [tail.ts](../src/physics/tail.ts) | tailRotorSpeed、tailThrustLimit、tailShaftTorque |
| 接地摩擦 | [ground.ts](../src/physics/ground.ts) | resolveSkidFriction |
| 动力学主循环与调度 | [simulator.ts](../src/physics/simulator.ts) | integrateStep、FixedStepClock |
| 向量、四元数、一阶响应 | [math.ts](../src/physics/math.ts) | integrateAttitude、lag |

## 附录 A：低转速叶素分支

来源：[rotor.ts](../src/physics/rotor.ts)，bladeElementLoads。

该分支用于低转速、停转及被动空气载荷。共有 12 个径向采样点与 8 个方位采样点：

$$
\Delta r=\frac{R-r_0}{12},
\qquad
r_k=r_0+(k+0.5)\Delta r,
\qquad
\psi_j=(j+0.5)\frac{2\pi}{8}
$$

输入为空间已转换后的桨盘坐标速度。当前主循环传入 $(V_t,V_a,0)$。每个叶素的速度为：

$$
U_t=\Omega r_k-V_x\sin\psi_j+V_z\cos\psi_j,
\qquad
U_a=V_a+v_i
$$

$$
\phi=\operatorname{atan2}(U_a,U_t),
\qquad
\alpha=\operatorname{atan2}
\left(\sin(\theta_0-\phi),\cos(\theta_0-\phi)\right)
$$

线性升力与大迎角近似的混合：

$$
C_{L,\mathrm{linear}}=\operatorname{clip}(5.7\alpha,-1.25,1.25)
$$

$$
b_\alpha=\operatorname{clip}\left(\frac{|\alpha|-0.22}{0.22},0,1\right)
$$

$$
C_L=(1-b_\alpha)C_{L,\mathrm{linear}}+1.1b_\alpha\sin(2\alpha)
$$

$$
C_D=0.012+0.018C_L^2+1.25\sin^2\alpha
$$

桨尖修正、升阻力：

$$
f_{\mathrm{tip}}=1-0.25(r_k/R)^8
$$

$$
dF_0=\frac12\rho(U_t^2+U_a^2)c\Delta r\,\frac{N_b}{8}
$$

$$
dL=dF_0C_Lf_{\mathrm{tip}},
\qquad
dD=dF_0C_D
$$

求和得到：

$$
T_{\mathrm{BEM}}=\sum_{k,j}(dL\cos\phi-dD\sin\phi)
$$

$$
Q_{\mathrm{BEM}}=\sum_{k,j}r_k(dL\sin\phi+dD\cos\phi)
$$

与第 7 节降阶模型的混合权重：

$$
x_\Omega=\operatorname{clip}\left(\frac{\Omega-5}{35},0,1\right),
\qquad
w_\Omega=x_\Omega^2(3-2x_\Omega)
$$

$$
(T_0,Q_0)
=
(1-w_\Omega)(T_{\mathrm{BEM}},Q_{\mathrm{BEM}})
+
w_\Omega(T_{\mathrm{reduced}},Q_{\mathrm{reduced}})
$$

- $\Omega\le5$ rad/s：纯低速叶素分支。
- $5<\Omega<40$ rad/s：平滑混合。
- $\Omega\ge40$ rad/s：直接使用降阶基础模型。

**两个阈值不能混淆：**基础叶素混合在 40 rad/s 结束；机动分离修正从 40 rad/s 开始、到 80 rad/s 完全接入。

## 附录 B：内部姿态辅助分支

主界面默认使用角速度模式，assist 为 false。内部保留姿态辅助外环：

$$
\mathbf u=\mathcal R(q)^T(0,1,0)
$$

$$
\phi_b=\operatorname{atan2}(-u_z,u_y),
\qquad
\theta_b=\operatorname{atan2}
\left(u_x,\sqrt{u_y^2+u_z^2}\right)
$$

补偿尾桨侧推的倾角：

$$
\phi_{\mathrm{trim}}
=
\operatorname{atan2}
\left(
-F_t,\sqrt{\max(1,(mg)^2-F_t^2)}
\right)
$$

目标角速度：

$$
\omega_{d,x}
=
\operatorname{clip}
\left(
4(24^\circ u_{\mathrm{roll}}+\phi_{\mathrm{trim}}-\phi_b),
-R_c,R_c
\right)
$$

$$
\omega_{d,z}
=
\operatorname{clip}
\left(
4(-24^\circ u_{\mathrm{pitch}}-\theta_b),
-R_c,R_c
\right)
$$

偏航仍走 Rates 曲线。该外环只改变目标角速度，后续仍使用相同的力矩域飞控和刚体动力学；它没有增加高度或位置保持。
